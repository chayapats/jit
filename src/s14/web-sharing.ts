import { tr, type MessageKey } from "../i18n";
import type { Work } from "./authority-types";
import type { ShareView, SnapshotTarget } from "./sharing-types";
import type { Bot } from "./types";
import { banner, botName, commandForm, e, hidden, k, notice, ownerStrip, pill, remaining, rid, shell, tile, untrusted, when } from "./web-pages";
import type { S14Page } from "./web";
import { memoryShareHours } from "./web-product-memory";
import { shareableBytes, type S14ShareDetail, type S14ShareFile, type S14ShareList, type S14ShareSheet, type S14ShareSnapshot, type S14SharingSurface } from "./web-product-sharing";
import { reach } from "./web-memory";
import { slotHref } from "./web-lifecycle";

/* Snapshot sharing (SHARE14-01, F12). A share is one exact copy for one Bot. File names and titles a model may have written stay escaped data outside the strip, and no line here reads as erasure. */
const stateTone: Record<ShareView["state"], [string, string]> = { active: ["strong", ""], revoked: ["", ""], expired: ["", ""], unavailable: ["warn", "!"] };
const statePill = (state: ShareView["state"]) => pill(tr(k(`s14.share.state.${state}`)), ...stateTone[state]);
const nameOf = (page: S14Page, id: string) => botName(page.state.bots.find(bot => bot.id === id) ?? { id, name: id });
const filled = (key: MessageKey, values: Record<string, string>) => tr(key).replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
const typeWord = (media: S14ShareSnapshot["mediaType"]) => tr(k(`s14.report.type.${media === "text/markdown" ? "markdown" : media === "text/plain" ? "text" : "json"}`));
const sizeText = (bytes: number) => `${bytes} ${tr("s14.report.bytes")}`;

/** Link to the share sheet for one exact snapshot. It is a read: only the sheet's form can create a share. */
export const shareHref = (target: SnapshotTarget, workId: string | null = null) => `/shares/new?kind=${target.kind}&amp;id=${e(target.id)}&amp;revision=${target.revision}&amp;generation=${target.generation}${workId ? `&amp;work=${e(workId)}` : ""}#slip`;
/** Report file row action: the link appears only when the gateway could accept the file. */
export const fileShare = (file: { id: string; size: number }) => file.size <= shareableBytes ? `<a class="s-btn" href="${shareHref({ kind: "artifact", id: file.id, revision: 1, generation: 1 })}">${tr("s14.share.this")}</a>` : `<p class="s-note">${tr("s14.share.too_large")}</p>`;

/** Memory source action. Forwarded or oversized originals are refused on the sheet, with the same gateway check the command uses. */
export const fileShareSource = (source: { id: string; revision: number; generation: number }) => `<p><a class="s-btn" href="${shareHref({ kind: "source", id: source.id, revision: source.revision, generation: source.generation })}">${tr("s14.share.this_source")}</a></p>`;

function shareRow(page: S14Page, view: ShareView): string {
  const { share } = view;
  return `<article class="s-mem" aria-label="${tr("s14.share.detail_title")} ${e(share.id)}"><div class="s-mem-hd">${statePill(view.state)}<span class="s-grow"></span><span class="s-meta">${tr("s14.share.field.until")} ${when(share.expiresAt)}</span></div><p class="s-mono s-share-name">${e(share.name)}</p><p class="s-meta">${e(filled("s14.share.from_to", { owner: nameOf(page, share.ownerBotId), receiver: nameOf(page, share.receiverBotId) }))} · <span class="s-mono">r${share.target.revision} g${share.target.generation}</span> · ${sizeText(share.size)}</p><div class="s-mem-acts"><a class="s-link-text" href="/shares/${e(share.id)}">${tr("s14.share.open")}</a></div></article>`;
}
function fileRow(file: S14ShareFile): string {
  const { artifact, title } = file;
  return `<li class="s-file"><div class="s-stack"><p class="s-mono s-share-name">${e(artifact.name)}</p><p class="s-meta">${e(title)} · ${sizeText(artifact.size)} · ${when(artifact.createdAt)}</p></div>${fileShare(artifact)}</li>`;
}
function listPage(page: S14Page, view: S14ShareList): string {
  const active = view.shares.filter(item => item.state === "active"), ended = view.shares.filter(item => item.state !== "active");
  const files = view.files.length ? `<ul class="s-files">${view.files.map(fileRow).join("")}</ul>${view.omitted ? `<p class="s-note">${tr("s14.share.files_more")}: ${view.omitted}</p>` : ""}` : `<p class="s-sub">${tr("s14.share.files_empty")}</p>`;
  return shell(page, tr("s14.share.title"), `<div class="s-col"><p class="s-sub">${tr("s14.share.lead")}</p><section class="s-stack" aria-labelledby="s14-share-active"><h2 class="s-section-t" id="s14-share-active">${tr("s14.share.active_title")}</h2>${active.map(item => shareRow(page, item)).join("") || `<p class="s-sub">${tr("s14.share.active_empty")}</p>`}</section><section class="s-stack" aria-labelledby="s14-share-files"><h2 class="s-section-t" id="s14-share-files">${tr("s14.share.files_title")}</h2>${files}<p class="s-note">${tr("s14.share.files_note")}</p></section>${ended.length ? `<section class="s-stack" aria-labelledby="s14-share-ended"><h2 class="s-section-t" id="s14-share-ended">${tr("s14.share.closed_title")}</h2>${ended.map(item => shareRow(page, item)).join("")}<p class="s-note">${tr("s14.memory.share.recall")}</p></section>` : ""}</div>`, { current: "more", subtitle: tr("s14.share.subtitle") });
}

/** The exact identity, in mono, so the owner reads what is pinned rather than a summary of it. */
function exactFacts(page: S14Page, identity: { target: SnapshotTarget; name: string; mediaType: S14ShareSnapshot["mediaType"]; size: number; sha256: string; ownerBotId: string }): string {
  const { target, name, mediaType, size, sha256, ownerBotId } = identity;
  return `<dl class="s-kv"><dt>${tr("s14.share.field.owner")}</dt><dd>${e(nameOf(page, ownerBotId))}</dd><dt>${tr("s14.share.field.kind")}</dt><dd>${tr(k(`s14.share.kind.${target.kind}`))}</dd><dt>${tr("s14.share.field.file")}</dt><dd class="s-mono">${e(name)}</dd><dt>${tr("s14.share.field.revision")}</dt><dd class="s-mono">r${target.revision} · g${target.generation}</dd><dt>${tr("s14.share.field.type")}</dt><dd>${e(typeWord(mediaType))} · <span class="s-mono">${e(mediaType)}</span></dd><dt>${tr("s14.share.field.size")}</dt><dd>${sizeText(size)}</dd><dt>SHA-256</dt><dd class="s-mono">${e(sha256)}</dd></dl>`;
}
/** Tasks stay in the page body, never in the strip: a Bot may have written their titles, so choosing one is a link to a reread sheet. */
function workBlock(view: S14ShareSheet): string {
  const clear = view.work ? `<p><a class="s-link-text" href="${shareHref(view.target)}">${tr("s14.share.work_clear")}</a></p>` : "";
  const current = view.work ? `<p class="s-sub">${tr("s14.share.work_only")}</p>${untrusted(`<p>${e(view.work.title)}</p>`, tr("s14.share.work_tag"))}${clear}` : `<p class="s-sub">${tr("s14.share.work_any")}</p>`;
  const others = view.tasks.filter(task => task.id !== view.work?.id), pick = (task: Work) => `<li class="s-stack">${untrusted(`<p>${e(task.title)}</p>`, tr("s14.share.work_tag"))}<p><a class="s-link-text" href="${shareHref(view.target, task.id)}">${tr("s14.share.work_limit")}</a></p></li>`;
  return `<section class="s-stack" aria-labelledby="s14-share-work"><h3 class="s-section-t" id="s14-share-work">${tr("s14.share.work_title")}</h3>${current}${others.length ? `<details class="s-more"><summary>${tr("s14.share.work_more")}</summary><div><ul class="s-history">${others.map(pick).join("")}</ul></div></details>` : ""}</section>`;
}
function receiverRow(page: S14Page, view: S14ShareSheet, bot: Bot, scopeId: string): string {
  const value = `${bot.id}:${bot.revision}:${scopeId}`, checked = view.chosen ? view.chosen === value : view.receivers.length === 1;
  return `<label class="s-choice"><input type="radio" name="receiver" value="${e(value)}" required${checked ? " checked" : ""}>${tile(bot, "", "small")}<span>${e(botName(bot))}</span></label>`;
}
function shareForm(page: S14Page, view: S14ShareSheet): string {
  const { target } = view;
  return `<form class="s-stack s-strip-form" method="post" action="/s14/forms/snapshot-share">${hidden("csrf", page.csrf)}${hidden("requestId", rid())}${hidden("targetKind", target.kind)}${hidden("targetId", target.id)}${hidden("targetRevision", target.revision)}${hidden("targetGeneration", target.generation)}${hidden("workId", view.work?.id ?? "")}<fieldset class="s-field"><legend>${tr("s14.share.field.receiver")}</legend><div class="s-choices">${view.receivers.map(item => receiverRow(page, view, item.bot, item.scopeId)).join("")}</div></fieldset><label class="s-field"><span>${tr("s14.memory.share.hours")}</span><input type="number" name="hours" min="${memoryShareHours.min}" max="${memoryShareHours.max}" value="${view.hours}" required inputmode="numeric"></label><div><button class="s-btn primary">${tr("s14.memory.share.submit")}</button></div></form>`;
}
/** The way out of "no receiver": one fixed link per Bot that opens its capability form with a free slot ticked. That page is where anything is decided. */
function slotActions(view: S14ShareSheet): string {
  const rows = view.others.filter(item => item.why === "no_slot").map(({ bot }) => `<li class="s-slot-row"><span class="s-row">${tile(bot, "", "small")}<span>${e(botName(bot))}<small class="s-meta">${tr("s14.share.blocked.no_slot")}</small></span></span><a class="s-btn" href="${slotHref(bot, view.target)}">${tr("s14.share.add_slot")}</a></li>`).join("");
  return rows ? `<ul class="s-slot-list">${rows}</ul>` : "";
}
function sheetPage(page: S14Page, view: S14ShareSheet): string {
  const back = `<p><a class="s-link-text" href="/shares">${tr("s14.share.back")}</a></p>`, snapshot = view.snapshot;
  if (!snapshot) return shell(page, tr("s14.share.sheet_title"), `<div class="s-col">${notice(view.refusal)}<p class="s-mono s-meta">${e(view.refusal)}</p>${back}</div>`, { current: "more" });
  const waiting = view.others.filter(item => item.why !== "no_slot" || view.receivers.length), blocked = waiting.length ? `<p class="s-note">${tr("s14.share.others")}: ${waiting.map(item => `${e(botName(item.bot))} (${tr(k(`s14.share.blocked.${item.why}`))})`).join(" · ")}</p>` : "";
  const noSlot = view.others.some(item => item.why === "no_slot"), jit = page.state.conversations.find(item => item.botId === "jit");
  const content = `<details class="s-more"><summary>${tr("s14.share.show_content")}</summary><div>${untrusted(`<pre class="s-exact">${e(snapshot.text)}</pre>`, tr("s14.share.content_tag"))}</div></details>`;
  const strip = view.receivers.length ? ownerStrip(shareForm(page, view), tr("s14.memory.share.note")) : "";
  const none = view.receivers.length ? (noSlot ? `<details class="s-more"><summary>${tr("s14.share.more_receivers")}</summary><div>${slotActions(view)}</div></details>` : "") : noSlot ? `${banner("", tr("s14.share.none_title"), tr("s14.share.none_detail"))}${slotActions(view)}` : banner("", tr("s14.share.none_title"), tr("s14.share.no_other_bot"), jit ? `<p><a class="s-link-text" href="/chats/${e(jit.id)}#s14-text">${tr("s14.share.ask_jit")}</a></p>` : "");
  return shell(page, tr("s14.share.sheet_title"), `<div class="s-col">${notice(view.notice)}<article class="s-slip" aria-label="${tr("s14.share.sheet_title")}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${tr("s14.share.sheet_title")}</h2><p class="s-meta">${tr("s14.share.sheet_meta")}</p></div></div><div class="s-slip-body">${exactFacts(page, snapshot)}<p class="s-note">${tr("s14.share.pinned_note")}</p>${content}${workBlock(view)}${reach(["s14.share.does_1", "s14.share.does_2", "s14.share.does_3", "s14.share.does_4"], ["s14.share.not_1", "s14.share.not_2", "s14.share.not_3", "s14.share.not_4", "s14.share.not_5"])}${none}${blocked}</div>${strip}</article>${back}</div>`, { current: "more", subtitle: tr("s14.share.subtitle") });
}

function revokeSlip(page: S14Page, view: S14ShareDetail): string {
  const { share } = view.view, receiver = nameOf(page, share.receiverBotId);
  const items = (entries: string[]) => `<ul class="s-reach-list">${entries.map(entry => `<li>${e(entry)}</li>`).join("")}</ul>`;
  const reachable = `<div class="s-slip-body"><div class="s-reach"><div><h3 class="s-section-t">${tr("s14.memory.reach.does")}</h3>${items([tr("s14.share.revoke.does_1"), tr("s14.share.revoke.does_2"), tr("s14.share.revoke.does_3"), tr("s14.share.revoke.does_4")])}</div><div><h3 class="s-section-t">${tr("s14.memory.reach.cannot")}</h3>${items([filled("s14.share.revoke.not_1", { bot: receiver }), tr("s14.memory.reach.external"), tr("s14.memory.reach.native"), tr("s14.share.revoke.not_2")])}</div></div></div>`;
  return `<article class="s-slip" aria-label="${tr("s14.share.revoke_title")}"><div class="s-slip-hd"><div><h2>${tr("s14.share.revoke_title")}</h2><p class="s-meta">${tr("s14.share.revoke_meta")}</p></div></div>${reachable}${ownerStrip(commandForm(page.csrf, "snapshot.revoke", share.revision, { shareId: share.id }, tr("s14.share.revoke"), "s-btn danger"), tr("s14.share.revoke_note"))}</article>`;
}
function detailPage(page: S14Page, view: S14ShareDetail): string {
  const { share, state, disclosedKnowledge } = view.view, receiver = nameOf(page, share.receiverBotId), back = `<p><a class="s-link-text" href="/shares">${tr("s14.share.back")}</a></p>`;
  const words = filled(k(`s14.share.detail.${state}`), { bot: receiver }), done = view.receipt ? (view.receipt.kind === "snapshot.revoke" ? tr("s14.share.done.revoke") : tr("s14.share.done.share")) : "";
  const landed = view.receipt ? banner("", done, view.receipt.kind === "snapshot.revoke" ? words : tr("s14.share.done.share_detail")) : "";
  const until = state === "active" ? `${when(share.expiresAt)} · ${remaining(share.expiresAt, page.now)}` : when(share.expiresAt);
  const scope = view.work ? `${tr("s14.share.work_only")} · <a class="s-link-text" href="/work/${e(view.work.id)}">${e(view.work.title)}</a>` : tr("s14.share.work_any");
  const facts = exactFacts(page, share);
  const summary = `<article class="s-slip" data-state="closed" aria-label="${tr("s14.share.detail_title")}"><div class="s-slip-hd"><div><h2>${tr("s14.share.detail_title")}</h2><p class="s-meta">${e(filled("s14.share.from_to", { owner: nameOf(page, share.ownerBotId), receiver }))}</p></div>${statePill(state)}</div><div class="s-slip-body">${state === "active" ? `<p class="s-sub">${e(words)}</p>` : banner(state === "unavailable" ? "warn" : "", tr(k(`s14.share.state.${state}`)), words)}${facts}<dl class="s-kv"><dt>${tr("s14.share.field.until")}</dt><dd>${until}</dd><dt>${tr("s14.share.field.work")}</dt><dd>${scope}</dd></dl>${state === "active" && disclosedKnowledge === "cannot_recall" ? `<p class="s-note">${tr("s14.memory.share.recall")}</p>` : ""}</div></article>`;
  const using = `<section class="s-stack" aria-labelledby="s14-share-using"><h2 class="s-section-t" id="s14-share-using">${tr("s14.share.using_title")}</h2>${view.using.length ? view.using.map(work => `<a class="s-work-row" href="/work/${e(work.id)}"><span><span>${e(work.title)}</span><small>${when(work.createdAt)}</small></span>${pill(tr(k(`s14.work_state.${work.state}`)))}</a>`).join("") : `<p class="s-sub">${tr("s14.share.using_empty")}</p>`}</section>`;
  return shell(page, tr("s14.share.detail_title"), `<div class="s-col">${landed}${summary}${using}${state === "active" ? revokeSlip(page, view) : ""}${back}</div>`, { current: "more", subtitle: tr("s14.share.subtitle") });
}
/** Renders the sharing surfaces. Every file name, Bot name and work title is escaped, and none of them reaches a button label. */
export function renderSharingSurface(page: S14Page, view: S14SharingSurface): string {
  return view.kind === "shares" ? listPage(page, view) : view.kind === "share-new" ? sheetPage(page, view) : detailPage(page, view);
}
