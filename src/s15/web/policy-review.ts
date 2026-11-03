import { currentLocale, tr } from "../../i18n";
import { banner, codeText, e, fill, form, hidden, key, pill, refusal } from "./render";
import type { S15BudgetEntry, S15PolicyReview, S15PolicyRow } from "./types";

/**
 * POLICY15-02 F1 step 5 and `/rules`: the exact default standing-policy proposal, derived by the protected service
 * from what this installation actually has. The owner reads the rows once and presses one button; the post carries
 * only the proposal hash (and the TEAM list hash the same click registers). Nothing here builds policy content.
 */
export interface S15PolicyReviewCard {
  csrf: string; review: S15PolicyReview;
  /** Where the forms return: the setup page or the rules page. */
  back: "setup" | "rules";
  options: { currencies: string[]; periods: { id: string; days: number }[] };
  entry: { amount: string; currency: string; periodId: string } | null; budget: S15BudgetEntry | null;
  refused: string | null;
  /** Installed standing policy expiry, for renewal wording. */
  currentExpiresAt: number | null; now: number;
}

const day = (value: number) => `<time datetime="${new Date(value).toISOString()}">${e(new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)))}</time>`;
const mono = (value: string) => `<span class="s-mono s15-break">${e(value)}</span>`;
const providerName = (id: string) => ({ codex: "OpenAI Codex", grok: "xAI Grok" } as Record<string, string>)[id] ?? id;

function rowValue(row: S15PolicyRow): string {
  if (row.kind === "bot") return row.id === "jit" ? `<b>${tr("s14.jit")}</b> ${mono(row.id)}` : mono(row.label);
  if (row.kind === "purpose") return `${tr(key(`s15.policy.purpose.${row.detail === "interpretation" ? "interpretation" : "work"}`))}`;
  if (row.kind === "model") return `<b>${e(row.label)}</b> <small>${tr(key(`s15.policy.charge.${row.detail === "metered" ? "metered" : "subscription"}`))}</small>`;
  if (row.kind === "recipient") return row.detail === "github" ? `<b>GitHub</b> <small>${tr("s15.policy.recipient.github")}</small>` : `<b>${e(providerName(row.label))}</b> <small>${tr("s15.policy.recipient.provider")}</small>`;
  if (row.kind === "repository") return `<b class="s-mono s15-break">${e(row.label)}</b>`;
  if (row.kind === "computer") return `${tr("s15.policy.computer_pool")} ${mono(row.label)}`;
  if (row.kind === "browser") return `${tr("s15.policy.browser")} <small>${tr("s15.policy.browser_note")}</small>`;
  return `<b>${e(row.label)}</b>`;
}

/** The exact rows grouped by what they are; every group lists the identities the hash binds. */
function rowsList(review: S15PolicyReview): string {
  const groups: [string, S15PolicyRow["kind"][]][] = [["bot", ["bot"]], ["purpose", ["purpose"]], ["resources", ["computer", "browser", "repository"]], ["models", ["model"]], ["recipients", ["recipient"]]];
  const items = groups.map(([id, kinds]) => {
    const rows = review.rows.filter(row => kinds.includes(row.kind));
    const extra = id === "resources" && !rows.some(row => row.kind === "repository") ? `<li class="s-sub">${tr("s15.policy.no_repositories")} <a class="s-link-text" href="/resources/github">${tr("s15.policy.connect_github")}</a></li>` : "";
    return `<dt>${tr(key(`s15.policy.group.${id}`))}</dt><dd><ul class="s15-facts">${rows.map(row => `<li>${rowValue(row)}</li>`).join("") || `<li class="s-sub">${tr("s15.setup.no_reviewed_value")}</li>`}${extra}</ul></dd>`;
  }).join("");
  return `<dl class="s-kv s15-policy-rows">${items}</dl>`;
}

/** Subscription routes need no money: show the finite per-work technical limits the protected registry applies. */
function limits(review: S15PolicyReview): string {
  const field = (path: string) => review.proposal?.fields.find(f => f.path === path)?.value;
  const calls = field("subscription.perWork.calls"), tools = field("subscription.tools.calls"), active = field("subscription.tools.activeMs"), parallel = field("subscription.concurrency");
  if (typeof calls !== "number" || typeof tools !== "number" || typeof active !== "number" || typeof parallel !== "number") return "";
  return `<div class="s15-policy-budget"><p><b>${tr("s15.policy.no_money_title")}</b></p><p class="s-sub">${tr("s15.policy.no_money_lead")}</p>
    <ul class="s15-facts"><li>${fill("s15.policy.limit.model_calls", { n: calls })}</li><li>${fill("s15.policy.limit.tool_calls", { n: tools })}</li><li>${fill("s15.policy.limit.hours", { n: Math.round(active / 3_600_000) })}</li><li>${fill("s15.policy.limit.parallel", { n: parallel })}</li></ul></div>`;
}

/** A metered route: the owner types a finite amount; currency and period come only from the route catalog. */
function budgetForm(card: S15PolicyReviewCard): string {
  const { options, entry } = card;
  const select = (name: string, label: string, items: { value: string; text: string }[], chosen: string) => `<label class="s-field"><span>${e(label)}</span>${items.length ? `<select name="${name}" required>${items.length > 1 ? `<option value=""${chosen ? "" : " selected"}>${tr("s15.budget.choose")}</option>` : ""}${items.map(item => `<option value="${e(item.value)}"${item.value === chosen || items.length === 1 ? " selected" : ""}>${e(item.text)}</option>`).join("")}</select>` : `<span class="s-sub">${tr("s15.setup.no_reviewed_value")}</span>`}</label>`;
  const typed = card.budget ? `<p class="s-row">${pill(tr("s15.policy.budget_set"), "ok", "✓")}</p>` : "";
  return `<div class="s15-policy-budget"><p><b>${tr("s15.policy.metered_title")}</b></p><p class="s-sub">${tr("s15.policy.metered_lead")}</p>${typed}${form("/s15/forms/rules/review", card.csrf, `${hidden("return", card.back)}<fieldset class="s-field"><legend>${tr("s15.budget.legend")}</legend>
      <label class="s-field"><span>${tr("s15.budget.amount")}</span><input name="amount" inputmode="decimal" autocomplete="off" value="${e(entry?.amount ?? "")}" aria-describedby="s15-policy-budget-note"></label>
      ${select("currency", tr("s15.budget.field.currency"), options.currencies.map(code => ({ value: code, text: code })), entry?.currency ?? "")}
      ${select("periodId", tr("s15.budget.period"), options.periods.map(period => ({ value: period.id, text: fill("s15.budget.days", { n: period.days }) })), entry?.periodId ?? "")}
      <p class="s-note" id="s15-policy-budget-note">${tr("s15.policy.metered_note")}</p></fieldset><div><button class="s-btn">${tr("s15.rules.review")}</button></div>`, ' class="s-stack"')}</div>`;
}

/** Whole card. `current` renders the installed state with the date renewal opens and no button. */
export function policyReviewCard(card: S15PolicyReviewCard): string {
  const r = card.review, id = "s15-policy-review";
  const expired = card.currentExpiresAt !== null && card.currentExpiresAt <= card.now;
  if (r.change === "current") return `<section class="s-stack" id="${id}" aria-labelledby="${id}-t"><h3 class="s-section-t" id="${id}-t">${tr("s15.policy.title.current")}</h3>
    <p>${tr("s15.rules.expires")} ${day(r.expiresAt!)} · ${tr("s15.policy.renew_from")} ${day(r.renewFrom!)}</p></section>`;
  const title = r.change === "renew" ? expired ? "s15.policy.title.expired" : "s15.policy.title.renew" : r.change === "update" ? "s15.policy.title.update" : "s15.policy.title.new";
  const lead = r.change === "renew" ? expired ? "s15.policy.lead.expired" : "s15.policy.lead.renew" : r.change === "update" ? "s15.policy.lead.update" : "s15.policy.lead.new";
  const held = `<div><p><b>${tr("s15.policy.held_title")}</b></p><div class="s15-chips">${r.held.map(c => `<span class="s-chip">${tr(key(`s15.class.${c}`))}</span>`).join("")}</div><p class="s-note">${tr("s15.policy.held_note")}</p></div>`;
  const personal = `<p class="s-note">${tr(r.personalGithub === "kept" ? "s15.policy.personal_kept" : "s15.policy.personal_off")} <a class="s-link-text" href="/rules#s15-rules-github">${tr("s15.policy.personal_where")}</a></p>`;
  const expiry = r.expiresAt ? `<p>${fill("s15.policy.expires_in", { days: Math.round((r.expiresAt - card.now) / 86_400_000) })} ${day(r.expiresAt)}. <span class="s-sub">${tr("s15.policy.renewable")}</span></p>` : "";
  const money = r.needsBudget ? budgetForm(card) : limits(r);
  const team = r.team ? `<p class="s-note">${fill("s15.policy.team_note", { n: r.team.count })}</p>` : "";
  const label = r.change === "renew" ? "s15.policy.install.renew" : r.change === "update" ? "s15.policy.install.update" : "s15.setup.apply_rules";
  const installable = !!r.proposal?.installable && !r.reason;
  const button = installable ? form("/s15/forms/rules/install", card.csrf, `${hidden("proposalHash", r.proposal!.proposalHash)}${r.team ? hidden("listHash", r.team.hash) : ""}${hidden("return", card.back)}<button class="s-btn primary">${tr(key(label))}</button>`, ' class="s15-strip-form"')
    : `<button class="s-btn primary" type="button" disabled aria-describedby="${id}-reason">${tr(key(label))}</button><p class="s-note" id="${id}-reason">${e(codeText(r.reason ?? "proposal_incomplete"))}${r.reason === "route_unavailable" ? ` <a class="s-link-text" href="#s15-setup-models">${tr("s15.policy.sign_in_first")}</a>` : ""}</p>`;
  const hash = installable ? `<p class="s-note">${tr("s15.rules.exact_note")} <span class="s-mono">${e(r.proposal!.proposalHash.slice(0, 12))}</span></p>` : "";
  return `<section class="s-stack" id="${id}" aria-labelledby="${id}-t">${refusal(card.refused)}<h3 class="s-section-t" id="${id}-t">${tr(key(title))}</h3><p class="s-sub">${tr(key(lead))}</p>
    ${expired ? `<div role="status">${banner("warn", tr("s15.policy.expired_banner"))}</div>` : ""}
    <h4 class="s-section-t">${tr("s15.policy.rows_title")}</h4>${rowsList(r)}${expiry}${held}${personal}${money}${team}<div class="s-row">${button}</div>${hash}</section>`;
}
