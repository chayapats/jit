import { tr } from "../../i18n";
import type { ConversationNeedsYou } from "../conversation";
import { banner, clock, codeText, e, fill, form, hidden, key, notYet, pill, refusal } from "./render";
import { fromMinor } from "./setup";
import type { S15ForgetImpact, S15MemoryClaim, S15ModelBudgetView } from "./types";

/** One Needs-you entry with the conversation it belongs to. */
export interface S15NeedItem { conversationId: string; entry: ConversationNeedsYou }
/** Only items that truly wait on the owner. Durable CI/review waits never appear here. Decisions on exact slips belong to UX15-02. */
export function needsBody(items: S15NeedItem[]): string {
  if (!items.length) return `<div class="s-col"><p class="s-sub">${tr("s15.needs.none")}</p></div>`;
  const group = (kind: ConversationNeedsYou["kind"]) => {
    const rows = items.filter(item => item.entry.kind === kind);
    return rows.length ? `<section class="s-attention-group" aria-labelledby="s15-needs-${kind}"><h2 id="s15-needs-${kind}">${tr(key(`s15.needs.group.${kind}`))}</h2><ul class="s-attention">${rows.map(({ conversationId, entry }) => {
      const slip = entry.slip, classes = slip ? slip.action.classes.map(name => `<span class="s-chip">${tr(key(`s15.class.${name}`))}</span>`).join("") : "";
      return `<li id="${e(entry.id)}"><a href="/chats/${e(conversationId)}#s15-row-${e(entry.requestId)}"><span><span>${e(codeText(entry.code))}</span>${slip ? `<small>r${slip.action.revision} · ${tr("s15.needs.expires")} ${clock(slip.expiresAt)}</small>` : ""}</span>${pill(tr(kind === "reconciliation" ? "s15.state.unknown" : kind === "question" ? "s15.state.question" : "s15.state.needs_you"), kind === "reconciliation" ? "danger" : "warn", kind === "reconciliation" ? "?" : "!")}</a>${classes ? `<div class="s15-chips">${classes}</div>` : ""}</li>`;
    }).join("")}</ul></section>` : "";
  };
  return `<div class="s-col s-attention-groups">${group("action")}${group("question")}${group("reconciliation")}<p class="s-note">${tr("s15.needs.slip_note")}</p></div>`;
}

const filters = ["all", "facts", "inferences", "preferences", "corrected", "forgotten", "s14"] as const;
export type S15MemoryFilter = typeof filters[number];
export const memoryFilter = (value: string | null): S15MemoryFilter => (filters as readonly string[]).includes(value ?? "") ? value as S15MemoryFilter : "all";
const matches = (claim: S15MemoryClaim, filter: S15MemoryFilter) => filter === "all" ? claim.lifecycle === "active" : filter === "facts" ? claim.lifecycle === "active" && claim.kind === "fact"
  : filter === "inferences" ? claim.lifecycle === "active" && claim.kind === "inference" : filter === "preferences" ? claim.lifecycle === "active" && claim.category === "preference"
  : filter === "corrected" ? claim.lifecycle === "superseded" || claim.supersedes !== null : filter === "forgotten" ? claim.lifecycle === "forgotten" : claim.provenance.scope.kind === "bot" && claim.provenance.scope.origin === "s14";
const scopeText = (claim: S15MemoryClaim) => claim.provenance.scope.kind === "team" ? tr("s15.resources.team") : claim.provenance.scope.origin === "s14" ? fill("s15.memory.s14_private", { bot: claim.provenance.scope.botId }) : fill("s15.resources.only", { bots: claim.provenance.scope.botId });

/** Memory page state: which claim is being corrected or forgotten, and the impact read for the forget sheet. */
export interface S15MemoryPage { csrf: string; claims: S15MemoryClaim[] | null; filter: S15MemoryFilter; correcting: string | null; forgetting: { claim: S15MemoryClaim; impact: S15ForgetImpact } | null; refused: string | null; saved: "corrected" | "forgotten" | null }
/** F8: inspect claims with their kind, source, scope and lifecycle; correct and forget by exact revision. */
export function memoryBody(page: S15MemoryPage): string {
  if (!page.claims) return `<div class="s-col">${notYet("s15.memory.not_composed")}</div>`;
  const nav = `<nav class="s-tabs" aria-label="${tr("s15.memory.filters")}">${filters.map(name => `<a href="/memory?filter=${name}"${page.filter === name ? ' aria-current="page"' : ""}>${tr(key(`s15.memory.filter.${name}`))}</a>`).join("")}</nav>`;
  const rows = page.claims.filter(claim => matches(claim, page.filter)).slice(0, 200);
  const row = (claim: S15MemoryClaim) => {
    const state = claim.lifecycle === "superseded" ? tr("s15.memory.corrected_by_you") : claim.lifecycle === "forgotten" ? tr("s15.memory.forgotten") : claim.sourceState === "withdrawn" ? tr("s15.memory.source_withdrawn") : "";
    const text = claim.text ? `<p class="s15-text">${e(claim.text)}</p>` : `<p class="s-sub">${tr("s15.memory.text_removed")}</p>`;
    const actions = claim.lifecycle === "active" ? `<p class="s-row"><a class="s-link-text" href="/memory?filter=${page.filter}&amp;claim=${e(claim.id)}#s15-claim-${e(claim.id)}">${tr("s15.memory.correct")}</a><a class="s-link-text" href="/memory?filter=${page.filter}&amp;forget=${e(claim.id)}#s15-claim-${e(claim.id)}">${tr("s15.memory.forget")}</a></p>` : "";
    const correcting = page.correcting === claim.id && claim.lifecycle === "active" ? form("/s15/forms/memory/correct", page.csrf, `${hidden("claimId", claim.id)}${hidden("claimRevision", claim.revision)}${hidden("filter", page.filter)}<label class="s-field"><span>${tr("s15.memory.correct_label")}</span><textarea name="text" rows="3" maxlength="2048" required>${e(claim.text)}</textarea></label><p class="s-note">${tr("s15.memory.correct_note")}</p><div class="s-row"><button class="s-btn primary">${tr("s15.memory.save_correction")}</button><a class="s-btn" href="/memory?filter=${page.filter}">${tr("s15.common.cancel")}</a></div>`, ' class="s-stack"') : "";
    const forgetting = page.forgetting?.claim.id === claim.id ? forgetSheet(page) : "";
    return `<li class="s15-claim" id="s15-claim-${e(claim.id)}">${text}<p class="s-meta">${pill(tr(claim.kind === "fact" ? "s15.memory.fact" : "s15.memory.inference"))}${claim.category === "preference" ? ` ${pill(tr("s15.memory.preference"))}` : ""} · ${tr(key(`s15.memory.source.${claim.provenance.origin.kind}`))} · ${clock(claim.createdAt)} · ${e(scopeText(claim))}${claim.confirmation === "owner_stated" ? ` · ${tr("s15.memory.owner_stated")}` : ""}</p>${state ? `<p class="s-sub">${e(state)}</p>` : ""}${actions}${correcting}${forgetting}</li>`;
  };
  const saved = page.saved ? `<div role="status">${banner("ok", tr(page.saved === "corrected" ? "s15.memory.saved_correction" : "s15.memory.saved_forget"))}</div>` : "";
  return `<div class="s-col">${saved}${refusal(page.refused)}<p class="s-sub">${tr("s15.memory.lead")}</p>${nav}${rows.length ? `<ul class="s15-claims">${rows.map(row).join("")}</ul>` : `<p class="s-sub">${tr("s15.memory.empty")}</p>`}<p class="s-note">${tr("s15.memory.no_import")}</p></div>`;
}
function forgetSheet(page: S15MemoryPage): string {
  const { claim, impact } = page.forgetting!;
  return `<div class="s-slip s15-forget" role="group" aria-labelledby="s15-forget-title"><div class="s-slip-hd"><div><h3 id="s15-forget-title" tabindex="-1">${tr("s15.memory.forget_title")}</h3></div></div><div class="s-slip-body"><p>${tr("s15.memory.forget_impact")}</p>
    <dl class="s-kv"><dt>${tr("s15.memory.impact.claims")}</dt><dd>${impact.claims}</dd><dt>${tr("s15.memory.impact.work")}</dt><dd>${impact.workItems}</dd><dt>${tr("s15.memory.impact.summaries")}</dt><dd>${impact.summaries + impact.artifacts}</dd></dl>${impact.workItems ? `<p class="s-note">${fill("s15.memory.impact.marked", { n: impact.workItems })}</p>` : ""}</div>
    <div class="s-strip"><div class="s-strip-acts">${form("/s15/forms/memory/forget", page.csrf, `${hidden("claimId", claim.id)}${hidden("claimRevision", claim.revision)}${hidden("filter", page.filter)}<button class="s-btn danger">${tr("s15.memory.forget")}</button>`)}<a class="s-btn" href="/memory?filter=${page.filter}">${tr("s15.common.cancel")}</a></div></div></div>`;
}

const amount = (value: number | string | null, dimension: string, currency: string | null) => value === null ? null : dimension === "spendMinor" && currency ? fromMinor(String(value), currency) : dimension === "activeMs" ? fill("s15.budget.minutes", { n: Math.round(Number(value) / 60000) }) : dimension === "outputBytes" ? `${Math.floor(Number(value) / 1024)} KiB` : String(value);
/** Meter: a 6 px bar plus words. Unknown usage is a hatched segment with the word, never zero. */
function meter(view: S15ModelBudgetView, item: S15ModelBudgetView["ceilings"][number]): string {
  const label = tr(key(`s15.budget.dimension.${item.dimension}`)), ceiling = amount(item.ceiling, item.dimension, view.currency);
  const charged = amount(item.charged, item.dimension, view.currency), measured = amount(item.measured, item.dimension, view.currency);
  const words = [`${tr("s15.budget.charged")} ${charged ?? tr("s15.budget.unknown")}`, `${tr("s15.budget.measured")} ${measured ?? tr("s15.budget.unknown")}`, ...(item.unknown ? [`${tr("s15.budget.unknown")}: ${tr("s15.budget.unknown_part")}`] : [])].join(" · ");
  const bar = item.ceiling !== null && item.charged !== null ? `<meter min="0" max="${e(String(item.ceiling))}" value="${e(String(item.charged))}" aria-label="${e(label)}">${e(words)}</meter>` : "";
  return `<div class="s-meter"><span>${e(label)}${ceiling ? ` · ${tr("s15.budget.ceiling")} ${e(ceiling)}` : ` · ${tr("s15.setup.no_reviewed_value")}`}</span><small>${e(words)}</small>${bar}${item.unknown ? '<span class="s-unknown-bar" aria-hidden="true"></span>' : ""}</div>`;
}
/** F10: approved routes, read-only pins and finite budget meters. Changes happen only through protected owner flows. */
export function modelsBody(view: S15ModelBudgetView | null, signInHref: string | null): string {
  if (!view) return `<div class="s-col">${notYet("s15.models.not_composed")}</div>`;
  const pinned = new Set(view.pins.flatMap(item => item.pins.model ? [item.pins.model.id] : []));
  const routes = view.routes.length ? `<ul class="s15-accounts">${view.routes.map(route => `<li><div class="s-grow"><p><b class="s-mono">${e(route.provider)} · ${e(route.model)}</b></p><p class="s-meta">${tr(key(`s15.models.charge.${route.charge}`))} · ${tr("s15.models.approved")}${pinned.has(route.selection.model.id) ? ` · ${tr("s15.model.pinned")}` : ""}</p>${route.availability === "available" ? "" : `<p class="s-sub">${fill(route.availability === "quota" ? "s15.models.quota" : "s15.models.unavailable", { provider: route.provider })} ${tr("s15.model.no_switch")}</p>`}</div>${pill(tr(key(`s15.models.availability.${route.availability}`)), route.availability === "available" ? "ok" : "warn", route.availability === "available" ? "✓" : "!")}</li>`).join("")}</ul>` : `<p class="s-sub">${tr("s15.models.none")}</p>`;
  const exhausted = view.ceilings.some(item => item.ceiling !== null && item.charged !== null && BigInt(String(item.charged)) >= BigInt(String(item.ceiling)));
  return `<div class="s-col">${exhausted ? `<div role="alert">${banner("warn", tr("s15.budget.exhausted"), tr("s15.budget.raise_here"))}</div>` : ""}<section class="s-card" aria-labelledby="s15-models-routes"><h2 id="s15-models-routes">${tr("s15.models.routes")}</h2>${routes}<p class="s-note">${tr("s15.models.add_note")}</p>${signInHref ? `<p><a class="s-btn" href="${e(signInHref)}">${tr("s15.models.add")}</a></p>` : ""}<p class="s-note">${tr("s15.models.pin_note")}</p></section>
    <section class="s-card" aria-labelledby="s15-models-budget"><h2 id="s15-models-budget">${tr("s15.budget.title")}</h2>${view.ceilings.length ? view.ceilings.map(item => meter(view, item)).join("") : `<p class="s-sub">${tr("s15.budget.none")}</p>`}${view.unsettled ? `<p class="s-note">${fill("s15.budget.unsettled", { n: view.unsettled })}</p>` : ""}<p class="s-note">${tr("s15.budget.note")}</p></section></div>`;
}
