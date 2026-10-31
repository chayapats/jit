import { tr } from "../i18n";
import type { Effect } from "./authority-types";
import type { PersonalDraft, PersonalDraftContent, PersonalEffectObservation, PersonalEventDraft, PersonalMailDraft } from "./personal-effect-types";
import type { S14Page } from "./web";
import { zoned } from "./web-personal-brief";
import { accountFact } from "./web-personal";
import { banner, botName, commandForm, e, effectBanner, effectPill, flat, hidden, k, notice, ownerStrip, pill, remaining, shell, untrusted, when } from "./web-pages";
import { canRead, type S14DraftCard, type S14DraftEdit, type S14DraftForm } from "./web-product-personal";
import { statementBlock, statementStrip, type S14StatementDraft } from "./web-statement";

/* Exact Gmail and Calendar cards (LIFE14-02, F9, F10). Every field the broker will send is shown here, in full and never summarised. A Bot wrote this text and it may repeat mail or event text, so it stays framed as data, and only typed revisions and the hash reach the strip. */
const none = () => `<span class="s-sub">${tr("s14.google.card.none")}</span>`;
const people = (items: string[]) => items.length ? `<ul class="s-google-people">${items.map(item => `<li class="s-mono">${e(item)}</li>`).join("")}</ul>` : none();
const row = (label: string, value: string) => `<dt>${e(label)}</dt><dd>${value}</dd>`;
const mono = (value: string) => `<span class="s-mono">${e(value)}</span>`;
function fromRow(card: S14DraftCard): string {
  const { draft } = card.view;
  return row(tr("s14.google.card.from"), draft.account === "[deleted]" ? tr("s14.google.card.deleted_account") : accountFact(card.connection ?? { account: draft.account, accountVerification: "owner_label" }));
}
function mailBlock(card: S14DraftCard, mail: PersonalMailDraft): string {
  const count = mail.to.length + mail.cc.length + mail.bcc.length;
  return `<dl class="s-kv">${fromRow(card)}${row(tr("s14.google.card.to"), people(mail.to))}${row(tr("s14.google.card.cc"), people(mail.cc))}${row(tr("s14.google.card.bcc"), `${people(mail.bcc)}${mail.bcc.length ? `<span class="s-note">${tr("s14.google.card.bcc_note")}</span>` : ""}`)}${row(tr("s14.google.card.count"), String(count))}</dl>
    ${untrusted(`<p class="s-exact-label">${tr("s14.google.card.subject")}</p><pre class="s-exact">${e(mail.subject)}</pre><p class="s-exact-label">${tr("s14.google.card.body")}</p><pre class="s-exact">${e(mail.body)}</pre>`, tr("s14.google.card.bot_text"))}`;
}
/** One instant in the event's zone next to the exact value that will be sent. */
const moment = (value: string, timezone: string) => `${zoned(Date.parse(value), timezone)}<br>${mono(value)}`;
function eventBlock(card: S14DraftCard, event: PersonalEventDraft): string {
  const fields = event.event, { draft } = card.view;
  const identity = `<dl class="s-kv">${row(tr("s14.google.card.change"), tr(k(`s14.google.card.op_${event.operation}`)))}${row(tr("s14.google.card.calendar"), draft.calendarId ? mono(draft.calendarId) : none())}${fromRow(card)}${row(tr("s14.google.card.event_id"), `${mono(event.eventId ?? "")}${event.operation === "create" ? `<br><span class="s-note">${tr("s14.google.card.event_id_new")}</span>` : ""}`)}${event.etag ? row(tr("s14.google.card.etag"), mono(event.etag)) : ""}${row(tr("s14.google.card.timezone"), mono(event.timezone))}${fields ? `${row(tr("s14.google.card.starts"), moment(fields.start, event.timezone))}${row(tr("s14.google.card.ends"), moment(fields.end, event.timezone))}${row(tr("s14.google.card.repeats"), fields.recurrence.length ? people(fields.recurrence) : tr("s14.google.card.no_repeat"))}${row(tr("s14.google.card.attendees"), people(fields.attendees))}` : ""}${row(tr("s14.google.card.notify"), tr(k(`s14.google.card.notify_${event.sendUpdates}`)))}</dl>`;
  if (!fields) return `${identity}${banner("warn", tr("s14.google.card.delete_title"), tr("s14.google.card.delete_detail"))}`;
  const text = untrusted(`<p class="s-exact-label">${tr("s14.google.card.summary")}</p><pre class="s-exact">${e(fields.summary)}</pre><p class="s-exact-label">${tr("s14.google.card.location")}</p><pre class="s-exact">${fields.location ? e(fields.location) : tr("s14.google.card.none")}</pre><p class="s-exact-label">${tr("s14.google.card.description")}</p><pre class="s-exact">${fields.description ? e(fields.description) : tr("s14.google.card.none")}</pre>`, tr("s14.google.card.bot_text"));
  return `${identity}${text}${event.operation === "update" ? `<p class="s-note">${tr("s14.google.card.update_note")}</p>` : ""}`;
}
/** Field-by-field difference against the previous stored revision. A field with no change is not listed. */
function draftDiff(card: S14DraftCard): string {
  const { draft, history } = card.view, old = history.find(item => item.revision === draft.revision - 1)?.content, now = draft.content;
  if (!old || !now || old.kind !== now.kind) return "";
  const flat_ = (content: PersonalDraftContent): [string, string][] => content.kind === "mail" ? [["to", content.to.join("\n")], ["cc", content.cc.join("\n")], ["bcc", content.bcc.join("\n")], ["subject", content.subject], ["body", content.body]]
    : [["timezone", content.timezone], ["notify", content.sendUpdates], ["summary", content.event?.summary ?? ""], ["location", content.event?.location ?? ""], ["description", content.event?.description ?? ""], ["starts", content.event?.start ?? ""], ["ends", content.event?.end ?? ""], ["repeats", content.event?.recurrence.join("\n") ?? ""], ["attendees", content.event?.attendees.join("\n") ?? ""]];
  const before = new Map(flat_(old)), rows = flat_(now).filter(([key, value]) => before.get(key) !== value).map(([key, value]) => `<div><p class="s-exact-label">${tr("s14.effect.what_changed")}: ${tr(k(`s14.google.card.${key}`))}</p><pre class="s-exact s-diff-old">${e(before.get(key) || tr("s14.google.card.none"))}</pre><pre class="s-exact s-diff-new">${e(value || tr("s14.google.card.none"))}</pre></div>`);
  return rows.join("");
}
const observationTone: Record<PersonalEffectObservation["state"], [string, string]> = { verified: ["strong", "✓"], accepted_unverified: ["warn", "!"], unknown: ["danger", "?"], not_applied: ["", ""] };
const observationPill = (item: PersonalEffectObservation) => pill(tr(k(`s14.google.observed.${item.state}`)), ...observationTone[item.state]);
/** What Google showed, kept apart from the dispatch state and from anything the owner states. */
function observationBlock(item: PersonalEffectObservation | null, effect: Effect): string {
  if (!item) return "";
  const details = `${item.providerId ? `<dt>${tr("s14.google.card.provider_id")}</dt><dd class="s-mono">${e(item.providerId)}</dd>` : ""}${item.etag ? `<dt>${tr("s14.google.card.etag")}</dt><dd class="s-mono">${e(item.etag)}</dd>` : ""}`;
  return `<section class="s-stack" aria-label="${tr("s14.google.observed.title")}">${effect.resolution ? "" : `<dl class="s-facts s-statement-facts"><div><dt>${tr("s14.google.observed.dispatch")}</dt><dd>${effectPill(effect.state)}</dd></div><div><dt>${tr("s14.google.observed.title")}</dt><dd>${observationPill(item)}</dd></div></dl>`}<p class="s-sub">${tr(k(`s14.google.meaning.${item.meaning}`))}</p><p class="s-meta">${tr("s14.google.observed.at")} ${when(item.checkedAt)}</p>${details ? `<dl class="s-kv">${details}</dl>` : ""}</section>`;
}
/** A read-only check of Google, with no way to write. When it cannot run the card says why, instead of showing a button that can only be refused. */
function readbackStrip(page: S14Page, card: S14DraftCard, full: boolean): string {
  const { draft, effect } = card.view;
  if (effect.state !== "unknown" || !draft.content) return "";
  const blocked = !card.usable ? "s14.google.readback.blocked_account" : draft.content.kind === "mail" && !canRead(card.connection!) ? "s14.google.readback.blocked_scope" : null;
  if (blocked) return `<div class="s-slip-body"><p class="s-note">${tr(k(blocked))}</p></div>`;
  if (!full) return "";
  return ownerStrip(`<form method="post" action="/s14/personal/drafts/${e(draft.id)}/readback">${hidden("csrf", page.csrf)}${hidden("expectedRevision", draft.revision)}${hidden("actionHash", draft.hash)}<button class="s-btn">${tr("s14.google.readback.go")}</button></form>`, tr("s14.google.readback.note"));
}
const approveKey = (draft: PersonalDraft) => draft.content?.kind === "event" ? `s14.google.approve.${draft.content.operation}` : "s14.google.approve.mail";
const headKey = (draft: PersonalDraft) => draft.content?.kind === "event" ? `s14.google.ask.${draft.content.operation}` : draft.content ? "s14.google.ask.mail" : "s14.google.ask.deleted";
/** The exact card, used on the effect page and in the work pane. Content precedes the strip, so the decision comes after reading what it binds to. */
export function personalSlip(page: S14Page, card: S14DraftCard, history: Effect[], level: "h2" | "h3", statement: S14StatementDraft | null): string {
  const { draft, effect, observation } = card.view, pending = effect.state === "pending", bot = page.state.bots.find(item => item.id === effect.botId), name = botName(bot ?? { id: effect.botId, name: effect.botId });
  const state = effect.state === "unknown" ? "unknown" : pending ? "pending" : "closed", anchor = level === "h2" ? ' id="slip" tabindex="-1" data-focus-on-load' : "";
  const decide = (decision: "approve" | "deny", label: string, cls: string) => commandForm(page.csrf, "approval.decide", effect.revision, { effectId: effect.id, actionHash: effect.actionHash, decision }, label, cls);
  const approvable = card.usable && effect.supported && !!draft.content, editable = level === "h2" && !!draft.content && pending;
  const strip = pending ? ownerStrip(`${approvable ? decide("approve", `${tr(k(approveKey(draft)))} · ${draft.hash.slice(0, 8)}`, "s-btn primary") : ""}${decide("deny", tr("s14.effect.deny"), "s-btn")}${editable ? `<a class="s-btn" href="/effects/${e(effect.id)}?edit=1#slip">${tr("s14.google.card.edit")}</a>` : ""}`, tr(approvable ? "s14.google.card.single_use" : "s14.google.card.cannot_run"))
    : `${readbackStrip(page, card, level === "h2")}${statementStrip(page, effect, level === "h2", statement)}`;
  const body = !draft.content ? banner("", tr("s14.google.card.deleted"), tr("s14.google.card.deleted_detail")) : draft.content.kind === "mail" ? mailBlock(card, draft.content) : eventBlock(card, draft.content);
  const closed = pending && !card.usable && draft.content ? banner("warn", tr("s14.google.card.account_changed"), tr("s14.google.card.account_changed_detail")) : "";
  return `<article class="s-slip" data-state="${state}" aria-label="${tr("s14.effect.card")}"><div class="s-slip-hd"><div><${level}${anchor}>${e(tr(k(headKey(draft))).replace("{bot}", () => name))}</${level}><p class="s-meta">${tr("s14.effect.irreversible")}</p></div>${effectPill(effect.state)}</div>
    <div class="s-slip-body">${effectBanner(effect, history)}${closed}${level === "h2" ? draftDiff(card) : ""}${body}<dl class="s-kv"><dt>${tr("s14.effect.revision")}</dt><dd class="s-mono">r${effect.revision} · d${draft.revision}</dd><dt>${tr("s14.effect.hash")}</dt><dd class="s-mono">${e(effect.actionHash)}</dd><dt>${tr("s14.effect.expires")}</dt><dd>${when(effect.expiresAt)}${pending ? ` · ${remaining(effect.expiresAt, page.now)}` : ""}</dd></dl>${observationBlock(observation, effect)}${statementBlock(effect, observation ? observationPill(observation) : undefined)}${level === "h3" && (effect.revision > 1 || effect.state === "unknown") ? `<p><a class="s-link-text" href="/effects/${e(effect.id)}#slip">${tr(effect.state === "unknown" ? "s14.statement.open" : "s14.effect.open_history")}</a></p>` : ""}</div>${strip}</article>`;
}

const area = (name: keyof S14DraftForm, label: string, value: string, rows: number, note = "", required = false) => `<div class="s-field"><label for="s14-draft-${name}">${e(label)}</label><textarea id="s14-draft-${name}" name="${name}" rows="${rows}"${required ? " required" : ""} autocapitalize="off" spellcheck="false">${e(value)}</textarea>${note ? `<span class="s-note">${e(note)}</span>` : ""}</div>`;
const input = (name: keyof S14DraftForm, label: string, value: string, cls = "", note = "") => `<div class="s-field"><label for="s14-draft-${name}">${e(label)}</label><input${cls ? ` class="${cls}"` : ""} id="s14-draft-${name}" name="${name}" value="${e(value)}" autocomplete="off" autocapitalize="off" spellcheck="false">${note ? `<span class="s-note">${e(note)}</span>` : ""}</div>`;
function mailFields(form: S14DraftForm): string {
  const note = tr("s14.google.edit.people_note");
  return `${area("to", tr("s14.google.card.to"), form.to, 2, note)}${area("cc", tr("s14.google.card.cc"), form.cc, 1)}${area("bcc", tr("s14.google.card.bcc"), form.bcc, 1)}${input("subject", tr("s14.google.card.subject"), form.subject)}${area("body", tr("s14.google.card.body"), form.body, 8)}`;
}
function eventFields(form: S14DraftForm, event: PersonalEventDraft): string {
  const zone = input("timezone", tr("s14.google.card.timezone"), form.timezone, "s-mono"), choice = (value: "all" | "none") => `<label class="s-choice"><input type="radio" name="sendUpdates" value="${value}"${form.sendUpdates === value ? " checked" : ""}><span>${tr(k(`s14.google.card.notify_${value}`))}</span></label>`;
  const notify = `<fieldset class="s-field"><legend>${tr("s14.google.card.notify")}</legend><div class="s-choices">${choice("none")}${choice("all")}</div></fieldset>`;
  if (!event.event) return `${zone}${notify}`;
  return `${input("summary", tr("s14.google.card.summary"), form.summary)}${input("location", tr("s14.google.card.location"), form.location)}${area("description", tr("s14.google.card.description"), form.description, 4)}${zone}${input("start", tr("s14.google.card.starts"), form.start, "s-mono", tr("s14.google.edit.time_note"))}${input("end", tr("s14.google.card.ends"), form.end, "s-mono")}${area("recurrence", tr("s14.google.card.repeats"), form.recurrence, 2, tr("s14.google.edit.repeat_note"))}${area("attendees", tr("s14.google.card.attendees"), form.attendees, 2, tr("s14.google.edit.people_note"))}${notify}`;
}
/** Owner edit of a held draft. Account, calendar and event identity are not fields: changing those needs new work, not a changed card. */
export function draftEditPage(page: S14Page, view: S14DraftEdit): string {
  const { draft, effect } = view.card.view, content = draft.content!;
  const form = `<form class="s-stack" method="post" action="/s14/forms/draft-revise">${flat(page.csrf, draft.revision)}${hidden("effectId", effect.id)}${hidden("draftId", draft.id)}${hidden("draftHash", draft.hash)}${hidden("expiresAt", draft.expiresAt)}${content.kind === "mail" ? mailFields(view.form) : eventFields(view.form, content)}<div class="s-row"><button class="s-btn primary">${tr("s14.google.edit.save")}</button><a class="s-btn" href="/effects/${e(effect.id)}#slip">${tr("s14.destroy.cancel")}</a></div></form>`;
  return shell(page, tr("s14.google.edit.title"), `<div class="s-col">${notice(view.notice)}${banner("", tr("s14.google.edit.lead"), tr("s14.google.edit.detail"))}<section class="s-card s-stack" aria-labelledby="slip"><h2 id="slip" tabindex="-1" data-focus-on-load>${tr("s14.google.edit.title")}</h2>${form}</section></div>`, { current: "work" });
}
