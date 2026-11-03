import { tr, trMaybe } from "../../i18n";
import { ownerStrip } from "../../s14/web-pages";
import type { ActionSlip, Rule, StandingPolicy } from "../policy";
import type { RecurringFrequency, RecurringRuleProposal } from "../policy/recurring";
import { exactAmount } from "./actions";
import { banner, clock, codeText, e, fill, form, hidden, key, notYet, refusal } from "./render";
import type { S15GithubCapture } from "./types";

/**
 * `/rules` (handoff F5 personal profile, F13 recurring payments). Every rule row is read from the installed
 * standing policy; setup and revoke are explicit owner commands. A personal GitHub exception is never a general
 * messaging or production exception, and a recurring rule never raises its own ceiling or frequency.
 */
export function frequencyLabel(minIntervalMs: number, frequencies: RecurringFrequency[]): string {
  const known = frequencies.find(f => f.minIntervalMs === minIntervalMs);
  return (known && trMaybe(`s15.rules.frequency.${known.id}`)) ?? fill("s15.rules.frequency.hours", { n: Math.round(minIntervalMs / 3600000) });
}
const mono = (value: string) => `<span class="s-mono s15-break">${e(value)}</span>`;

export interface S15RulesPage {
  csrf: string; policy: StandingPolicy | null; rulesAvailable: boolean;
  recurring: { frequencies: RecurringFrequency[]; payments: { slip: ActionSlip }[] } | null;
  github: { capture: S15GithubCapture | null } | null;
  refused: string | null; saved: string | null;
  /** POLICY15-02 pre-rendered default-proposal review (update or renewal), or empty. */
  review?: string;
}

function recurringRow(rule: Rule, page: S15RulesPage): string {
  const r = rule.recurrence!, frequencies = page.recurring?.frequencies ?? [];
  const revoke = page.recurring ? ownerStrip(form("/s15/forms/recurring/revoke", page.csrf, `${hidden("ruleId", rule.id)}<button class="s-btn">${tr("s15.rules.revoke")}</button>`), tr("s15.rules.revoke_note")) : "";
  return `<li class="s-slip" data-state="closed"><div class="s-slip-hd"><div><h3>${tr("s15.rules.recurring_rule")}</h3><p class="s-meta s-mono">${e(rule.id)}</p></div></div><div class="s-slip-body"><dl class="s-kv">
    <dt>${tr("s15.slip.payee")}</dt><dd>${mono(r.payee.id)}</dd><dt>${tr("s15.slip.account")}</dt><dd>${mono(r.account.id)}</dd><dt>${tr("s15.rules.ceiling")}</dt><dd><b class="s-mono">${e(exactAmount(r.amountCeilingMinor, r.minorUnit, r.currency))}</b></dd>
    <dt>${tr("s15.rules.frequency")}</dt><dd>${e(frequencyLabel(r.minIntervalMs, frequencies))}</dd><dt>${tr("s15.rules.max_payments")}</dt><dd>${r.maxPayments}</dd><dt>${tr("s15.rules.total")}</dt><dd class="s-mono">${e(exactAmount(r.totalCeilingMinor, r.minorUnit, r.currency))}</dd><dt>${tr("s15.rules.expires")}</dt><dd>${clock(rule.expiresAt)}</dd></dl>
    <p class="s-note">${tr("s15.rules.recurring_scope")}</p></div>${revoke}</li>`;
}

function githubSection(page: S15RulesPage): string {
  const personal = page.policy?.rules.filter(r => r.mode === "personal_github_publish" || r.mode === "personal_github_merge") ?? [];
  const installed = personal.length ? `<ul class="s15-facts">${personal.map(r => `<li>${tr(key(`s15.github.mode.${r.mode}`))} · ${mono(r.github?.repository.id ?? "")} → ${mono(r.github?.target ?? "")}${r.github?.requiredChecks?.length ? ` · ${tr("s15.github.required_checks")}: ${r.github.requiredChecks.map(mono).join(", ")}` : ""}</li>`).join("")}</ul>` : `<p>${tr("s15.github.personal_off")}</p>`;
  const fixed = `<p class="s-note">${tr("s15.github.production_fixed")} · ${tr("s15.github.not_messaging")}</p>`;
  if (!page.github) return `<section class="s-card" id="s15-rules-github" aria-labelledby="s15-rules-github-t"><h2 id="s15-rules-github-t">${tr("s15.github.profile_title")}</h2>${installed}${fixed}${notYet("s15.github.not_composed")}</section>`;
  const capture = page.github.capture;
  const revoke = personal.length && capture ? ownerStrip(form("/s15/forms/github/revoke", page.csrf, `${hidden("captureId", capture.captureId)}<button class="s-btn">${tr("s15.github.revoke")}</button>`), tr("s15.github.revoke_note")) : "";
  const start = !capture ? form("/s15/forms/github/capture", page.csrf, `<button class="s-btn">${tr(personal.length ? "s15.github.review_profile" : "s15.github.set_up")}</button>`) : "";
  const setup = capture ? form("/s15/forms/github/install", page.csrf, `${hidden("captureId", capture.captureId)}<fieldset><legend>${tr("s15.github.repositories")}</legend>${capture.repositories.map(entry => {
      const checks = entry.protection.known && entry.protection.requiredChecks.length ? `${tr("s15.github.required_checks")}: ${entry.protection.requiredChecks.map(mono).join(", ")} · ${fill("s15.github.required_reviews", { n: entry.protection.requiredApprovals })}` : tr("s15.github.no_protection");
      return `<label class="s-check"><input type="checkbox" name="repo_${e(entry.repository.resource.id)}" value="1"><span><b class="s-mono">${e(entry.repository.name)}</b> → <span class="s-mono">${e(entry.repository.target)}</span><small>${checks} · ${tr("s15.github.check.production")}: ${tr(key(`s15.github.production.${entry.production.consequence}`))}${entry.autoMergeAvailable ? "" : ` · ${tr("s15.github.no_auto_merge")} ${codeText(entry.reason)}`}</small></span></label>`;
    }).join("")}</fieldset>
    <label class="s-check"><input type="checkbox" name="publication" value="1"><span>${tr("s15.github.allow_publication")}</span></label><label class="s-check"><input type="checkbox" name="merge" value="1"><span>${tr("s15.github.allow_merge")}</span></label>
    ${fixed}<p class="s-note">${tr("s15.github.checks_note")}</p><div class="s-row"><button class="s-btn primary">${tr("s15.github.enable")}</button><a class="s-btn" href="/rules#s15-rules-github">${tr("s15.common.cancel")}</a></div>`, ' class="s-stack"') : "";
  return `<section class="s-card" id="s15-rules-github" aria-labelledby="s15-rules-github-t"><h2 id="s15-rules-github-t">${tr("s15.github.profile_title")}</h2>${installed}${fixed}${start}${setup}${revoke}</section>`;
}

export function rulesBody(page: S15RulesPage): string {
  if (!page.rulesAvailable) return `<div class="s-col">${notYet("s15.rules.not_composed")}</div>`;
  const policy = page.policy;
  const saved = page.saved ? `<div role="status">${banner("ok", tr(key(`s15.rules.saved.${page.saved}`)))}</div>` : "";
  const summary = `<section class="s-card" aria-labelledby="s15-rules-summary"><h2 id="s15-rules-summary">${tr("s15.rules.title")}</h2>${policy ? `<p>${fill("s15.rules.active", { n: policy.revision })} · ${tr("s15.rules.expires")} ${clock(policy.expiresAt)}</p>` : `<p>${tr("s15.rules.none")} <a class="s-link-text" href="/setup#s15-setup-rules">${tr("s15.nav.setup")}</a></p>`}
    <div class="s15-rule-lists"><div><h3>${tr("s15.setup.does_alone")}</h3><ul>${["research", "computer", "edits", "accounts", "models"].map(k => `<li>${tr(key(`s15.setup.alone.${k}`))}</li>`).join("")}</ul></div><div><h3>${tr("s15.setup.always_asks")}</h3><ul>${["messages", "github", "merge", "production", "payments", "recipients", "major", "new_accounts"].map(k => `<li>${tr(key(`s15.setup.asks.${k}`))}</li>`).join("")}</ul></div></div></section>`;
  const recurringRules = policy?.rules.filter(r => r.mode === "recurring_payment" && r.recurrence) ?? [];
  const add = page.recurring ? (page.recurring.payments.length ? `<h3>${tr("s15.rules.recurring_add")}</h3><p class="s-sub">${tr("s15.rules.recurring_add_lead")}</p><ul class="s15-facts">${page.recurring.payments.map(({ slip }) => { const t = slip.action.transaction!; return `<li><a class="s-link-text" href="/rules/recurring?from=${e(slip.action.id)}&amp;r=${slip.action.revision}">${mono(t.payee.id)} · ${e(exactAmount(t.amountMinor, t.minorUnit, t.currency))}</a></li>`; }).join("")}</ul>` : `<p class="s-sub">${tr("s15.rules.recurring_no_payees")}</p>`) : notYet("s15.rules.recurring_not_composed");
  const recurring = `<section class="s-card" id="s15-rules-recurring" aria-labelledby="s15-rules-recurring-t"><h2 id="s15-rules-recurring-t">${tr("s15.rules.recurring_title")}</h2>${recurringRules.length ? `<ul class="s15-rule-list">${recurringRules.map(r => recurringRow(r, page)).join("")}</ul>` : `<p class="s-sub">${tr("s15.rules.recurring_none")}</p>`}${add}</section>`;
  const review = page.review ? `<section class="s-card" aria-label="${tr("s15.policy.review_label")}">${page.review}</section>` : "";
  return `<div class="s-col">${saved}${refusal(page.refused)}${summary}${review}${githubSection(page)}${recurring}</div>`;
}

/** F13 RuleProposal: step one picks a ceiling and a supported frequency from an exact payment; step two shows the exact rule. */
export function recurringProposalBody(input: { csrf: string; slip: ActionSlip; frequencies: RecurringFrequency[]; proposal: RecurringRuleProposal | null; ceiling: string; frequencyId: string; refused: string | null; fromJit: boolean }): string {
  const t = input.slip.action.transaction!, heading = tr(input.fromJit ? "s15.rules.recurring_proposed" : "s15.rules.recurring_new");
  const fixed = `<dl class="s-kv"><dt>${tr("s15.slip.payee")}</dt><dd>${mono(t.payee.id)}</dd><dt>${tr("s15.slip.account")}</dt><dd>${mono(t.account.id)}</dd><dt>${tr("s15.rules.currency")}</dt><dd class="s-mono">${e(t.currency)}</dd><dt>${tr("s15.rules.from_payment")}</dt><dd>${e(exactAmount(t.amountMinor, t.minorUnit, t.currency))}</dd></dl>`;
  if (input.proposal) {
    const rule = input.proposal.rule, r = rule.recurrence!;
    return `<div class="s-col">${refusal(input.refused)}<article class="s-slip s15-slip" data-state="open" aria-labelledby="s15-slip-title"><div class="s-slip-hd"><div><h2 id="s15-slip-title" tabindex="-1">${heading}</h2><div class="s15-chips"><span class="s-chip">${tr("s15.class.financial")}</span></div></div></div><div class="s-slip-body"><dl class="s-kv">
      <dt>${tr("s15.slip.payee")}</dt><dd>${mono(r.payee.id)}</dd><dt>${tr("s15.slip.account")}</dt><dd>${mono(r.account.id)}</dd><dt>${tr("s15.rules.currency")}</dt><dd class="s-mono">${e(r.currency)}</dd><dt>${tr("s15.rules.ceiling")}</dt><dd><b class="s-mono">${e(exactAmount(r.amountCeilingMinor, r.minorUnit, r.currency))}</b></dd>
      <dt>${tr("s15.rules.frequency")}</dt><dd>${e(frequencyLabel(r.minIntervalMs, input.frequencies))}</dd><dt>${tr("s15.rules.max_payments")}</dt><dd>${r.maxPayments}</dd><dt>${tr("s15.rules.total")}</dt><dd class="s-mono">${e(exactAmount(r.totalCeilingMinor, r.minorUnit, r.currency))}</dd><dt>${tr("s15.rules.expires")}</dt><dd>${clock(rule.expiresAt)}</dd></dl>
      <p>${tr("s15.rules.recurring_scope")}</p><p class="s-meta s-mono">${e(input.proposal.proposalHash)}</p></div>
      ${ownerStrip(`${form("/s15/forms/recurring/install", input.csrf, `${hidden("proposalHash", input.proposal.proposalHash)}<button class="s-btn primary">${tr("s15.rules.recurring_set")}</button>`)}<a class="s-btn" href="/rules#s15-rules-recurring">${tr("s15.rules.recurring_discard")}</a>`, tr("s15.rules.recurring_exact_note"))}</article></div>`;
  }
  const frequencies = input.frequencies.length ? `<fieldset><legend>${tr("s15.rules.frequency")}</legend>${input.frequencies.map(f => `<label class="s-check"><input type="radio" name="frequencyId" value="${e(f.id)}"${input.frequencyId === f.id ? " checked" : ""} required><span>${e(frequencyLabel(f.minIntervalMs, input.frequencies))}</span></label>`).join("")}</fieldset>` : `<p class="s-sub">${tr("s15.rules.no_frequencies")}</p>`;
  const body = `${hidden("actionId", input.slip.action.id)}${hidden("revision", input.slip.action.revision)}${hidden("actionHash", input.slip.action.actionHash)}${fixed}<label class="s-field"><span>${fill("s15.rules.ceiling_in", { currency: t.currency })}</span><input name="ceiling" inputmode="decimal" autocomplete="off" required value="${e(input.ceiling)}"></label>${frequencies}
    <p class="s-note">${tr("s15.rules.recurring_scope")}</p><div class="s-row">${input.frequencies.length ? `<button class="s-btn primary">${tr("s15.rules.recurring_review")}</button>` : ""}<a class="s-btn" href="/rules#s15-rules-recurring">${tr("s15.common.cancel")}</a></div>`;
  return `<div class="s-col">${refusal(input.refused)}<section class="s-card" aria-labelledby="s15-slip-title"><h2 id="s15-slip-title" tabindex="-1">${heading}</h2><p class="s-sub">${tr("s15.rules.recurring_separate")}</p>${form("/s15/forms/recurring/propose", input.csrf, body, ' class="s-stack"')}</section></div>`;
}
