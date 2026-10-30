import { tr } from "../i18n";
import type { Effect } from "./authority-types";
import { banner, e, flat, hidden, pill, ownerStrip, untrusted, when } from "./web-pages";
import type { S14Page } from "./web";

/** Fields kept across a refused statement. The note is dropped when it looks like a credential. */
export interface S14StatementDraft { outcome: "occurred" | "did_not_occur" | null; note: string }
/** The ledger stores no note text, so a statement restored from it carries this exact placeholder. */
const restoredNote = "[restored owner statement]";

/* F10 after REC14-01: what Jit observed and what the owner stated stay two separate facts. Nothing here reads as verified, and no green or check mark appears even when the owner says it happened. */
function ledger(effect: Effect): string {
  const row = (label: string, value: string) => `<div><dt>${label}</dt><dd>${value}</dd></div>`, stated = effect.resolution!;
  return `<dl class="s-facts s-statement-facts" aria-label="${tr("s14.effect.card")}">${row(tr("s14.statement.observed"), pill(tr("s14.effect_state.unknown"), "danger", "?"))}${row(tr("s14.statement.stated"), pill(tr(stated.outcome === "occurred" ? "s14.statement.occurred" : "s14.statement.did_not_occur")))}${row(tr("s14.statement.checked"), pill(tr("s14.statement.not_checked")))}${row(tr("s14.statement.recorded"), when(stated.recordedAt))}</dl>`;
}
/** Banner of an unknown effect, before and after the owner's statement. Its tone stays neutral after one: the outcome is still unknown, but nothing waits on the owner. */
export function statementBanner(effect: Effect): string {
  return effect.resolution ? banner("", tr("s14.statement.banner_title"), tr("s14.statement.banner_detail")) : banner("danger", tr("s14.effect_state.unknown"), tr("s14.effect.unknown_detail"), `<p class="s-sub">${tr("s14.effect.unknown_next")}</p>`);
}
/** The recorded statement, labelled as the owner's and shown apart from the observed state. */
export function statementBlock(effect: Effect): string {
  if (!effect.resolution) return "";
  const note = effect.resolution.note === restoredNote ? `<p class="s-note">${tr("s14.statement.note_lost")}</p>` : untrusted(`<p>${e(effect.resolution.note)}</p>`, tr("s14.statement.note_tag"));
  return `<section class="s-stack" aria-label="${tr("s14.statement.stated")}">${ledger(effect)}${note}</section>`;
}
/** Records what the owner knows. It lives only on the card's own page, where a live refresh cannot take a half-typed note. No retry or send control exists on this card. */
export function statementStrip(page: S14Page, effect: Effect, full: boolean, draft: S14StatementDraft | null): string {
  if (effect.state !== "unknown" || effect.resolution) return "";
  if (!full) return ownerStrip(`<a class="s-btn" href="/effects/${e(effect.id)}#slip">${tr("s14.statement.open")}</a>`, tr("s14.statement.lead"));
  const option = (value: "occurred" | "did_not_occur") => `<label class="s-choice"><input type="radio" name="outcome" value="${value}" required${draft?.outcome === value ? " checked" : ""}><span>${tr(value === "occurred" ? "s14.statement.occurred" : "s14.statement.did_not_occur")}</span></label>`;
  const form = `<form class="s-stack s-strip-form s-statement" method="post" action="/s14/forms/effect-reconcile">${flat(page.csrf, effect.revision)}${hidden("effectId", effect.id)}${hidden("actionHash", effect.actionHash)}<fieldset class="s-field"><legend>${tr("s14.statement.legend")}</legend><div class="s-choices">${option("occurred")}${option("did_not_occur")}</div></fieldset><label class="s-field"><span>${tr("s14.statement.note")}</span><textarea name="note" required maxlength="2000">${e(draft?.note ?? "")}</textarea><span class="s-note">${tr("s14.statement.note_hint")}</span></label><div><button class="s-btn">${tr("s14.statement.submit")}</button></div></form>`;
  return ownerStrip(form, tr("s14.statement.leave"), `<p class="s-sub">${tr("s14.statement.lead")}</p>`);
}
