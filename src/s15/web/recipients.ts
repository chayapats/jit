import { currentLocale, tr } from "../../i18n";
import { banner, e, fill, form, hidden, refusal } from "./render";
import type { S15WebRecipients } from "./types";

type Lists = ReturnType<S15WebRecipients<unknown>["list"]>;
function day(value: number): string {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return "";
  const text = new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
  return `<time datetime="${date.toISOString()}">${e(text)}</time>`;
}

/**
 * AUTH16-01 settings page: people the owner's own messages named (sends to them run without a card) and private-data
 * recipients the owner approved once (S16-D07 g, remembered for every Bot). Forgetting returns either to the card.
 */
export function recipientsBody(input: { lists: Lists | null; csrf: string; refused: string | null; saved: boolean }): string {
  const lead = `<p class="s-sub">${tr("s15.recipients.lead")}</p>`;
  if (!input.lists) return `<div class="s-col">${lead}${banner("", tr("s15.recipients.not_composed"), tr("s15.common.not_available_detail"))}</div>`;
  const people = input.lists.people.length ? `<ul class="s15-accounts" aria-label="${tr("s15.recipients.people_title")}">${input.lists.people.map(p => `<li><div class="s-grow"><p><b class="s-mono s15-break">${e(p.address)}</b>${p.label ? ` · ${e(p.label)}` : ""}</p><p class="s-meta">${tr("s15.recipients.added_on")} ${day(p.addedAt)}</p></div>
    ${form("/s15/forms/recipients/forget-person", input.csrf, `${hidden("address", p.address)}<button class="s-btn" aria-label="${fill("s15.recipients.forget_label", { name: p.address })}">${tr("s15.recipients.forget")}</button>`, ' class="s15-strip-form"')}</li>`).join("")}</ul>` : `<p class="s-sub">${tr("s15.recipients.people_none")}</p>`;
  const remembered = input.lists.remembered.length ? `<ul class="s15-accounts" aria-label="${tr("s15.recipients.remembered_title")}">${input.lists.remembered.map(r => `<li><div class="s-grow"><p><b class="s-mono s15-break">${e(r.label)}</b></p><p class="s-meta">${e(r.dataClasses.join(", "))} · ${tr("s15.recipients.remembered_on")} ${day(r.rememberedAt)}</p></div>
    ${form("/s15/forms/recipients/forget", input.csrf, `${hidden("recipientId", r.recipientId)}${hidden("revision", r.revision)}<button class="s-btn" aria-label="${fill("s15.recipients.forget_label", { name: r.label })}">${tr("s15.recipients.forget")}</button>`, ' class="s15-strip-form"')}</li>`).join("")}</ul>` : `<p class="s-sub">${tr("s15.recipients.remembered_none")}</p>`;
  return `<div class="s-col">${lead}${input.saved ? `<div role="status">${banner("ok", tr("s15.recipients.saved"))}</div>` : ""}${refusal(input.refused)}
    <section class="s-card" aria-labelledby="s15-rcp-people"><h2 id="s15-rcp-people">${tr("s15.recipients.people_title")}</h2><p class="s-note">${tr("s15.recipients.people_note")}</p>${people}</section>
    <section class="s-card" aria-labelledby="s15-rcp-remembered"><h2 id="s15-rcp-remembered">${tr("s15.recipients.remembered_title")}</h2><p class="s-note">${tr("s15.recipients.remembered_note")}</p>${remembered}</section></div>`;
}
