import { tr } from "../../i18n";
import { ownerStrip, untrusted } from "../../s14/web-pages";
import type { Usage } from "../policy";
import type { ResponsibilityProjection } from "../work";
import { banner, clip, clock, codeText, e, fill, form, hidden, key, pill, statePill, type S15State } from "./render";

/**
 * UX15-02c responsibilities, durable waits and stall reports (handoff F9). Durable waits read calm and never enter
 * Needs you; a paused responsibility explains itself and offers exactly three replies; stop names its scope.
 */
export function dutyState(duty: ResponsibilityProjection): S15State {
  switch (duty.state) {
    case "accepted": return "received";
    case "ready": case "working": return "working";
    case "waiting": return duty.wait?.kind === "ci" ? "waiting_ci" : duty.wait?.kind === "review" ? "waiting_review" : duty.wait?.kind === "owner" ? "needs_you" : "waiting_schedule";
    case "paused": return "stalled";
    case "reconcile_only": return "unknown";
    case "completed": return "done";
    case "stopping": return "stopping";
    case "stopped": return "stopped";
  }
}
/** Only paused or owner-waiting responsibilities, or unknown attempts, wait on the owner. CI/review waits never do. */
export const dutyNeedsYou = (duty: ResponsibilityProjection) => duty.state === "paused" || duty.state === "reconcile_only" || (duty.state === "waiting" && duty.wait?.kind === "owner");
const name = (duty: ResponsibilityProjection) => clip(duty.originalText, 60);

/** Budget used for this work, in words. Unknown parts are named, never shown as zero. */
function budgetWords(duty: ResponsibilityProjection): string {
  const dims: (keyof Usage)[] = ["calls", "activeMs", "spendMinor"];
  const words = dims.map(dim => {
    const charged = duty.budget.charged[dim], label = tr(key(`s15.budget.dimension.${dim}`));
    const value = charged === null ? tr("s15.budget.unknown") : dim === "activeMs" ? fill("s15.budget.minutes", { n: Math.round(Number(charged) / 60000) }) : String(charged);
    return `${label} ${value}`;
  });
  return `${tr("s15.budget.charged")}: ${words.join(" · ")}${duty.budget.unknown.length ? ` · ${tr("s15.stall.budget_unknown")}` : ""}`;
}

/** F9 StallReport: numbered attempts with evidence, budget words, untrusted recommendation and the three replies. */
function stallReport(duty: ResponsibilityProjection, csrf: string): string {
  const report = duty.report; if (!report) return "";
  const resumed = duty.state === "ready" || duty.state === "working" || duty.state === "waiting";
  const attempts = `<ol class="s15-attempts">${report.attempts.map(attempt => `<li><p class="s15-text">${e(attempt.approach)}</p><p class="s-meta">${tr(key(`s15.stall.progress.${attempt.progress}`))}${attempt.evidenceRefs.length ? ` · ${tr("s15.stall.evidence")}: ${attempt.evidenceRefs.map(ref => `<span class="s-mono">${e(ref)}</span>`).join(", ")}` : ` · ${tr("s15.result.no_evidence")}`}</p></li>`).join("")}</ol>`;
  const choices = duty.state === "paused" && !duty.stopRequested ? `<div class="s15-chips"><a class="s-btn" href="/chats/${e(duty.conversationId)}?duty=${e(duty.id)}&amp;reply=recommended#s15-text">${tr("s15.stall.try_recommended")}</a><a class="s-btn" href="/chats/${e(duty.conversationId)}?duty=${e(duty.id)}&amp;reply=other#s15-text">${tr("s15.stall.other_way")}</a>${stopForm(duty, csrf, tr("s15.stall.stop"))}</div><p class="s-note">${fill("s15.duty.stop_scope", { name: name(duty), n: duty.stopImpact.otherResponsibilities })}</p>` : "";
  const next = resumed ? `<div role="status">${banner("ok", tr("s15.stall.resumed"))}</div>` : duty.state === "stopping" ? banner("", tr("s15.duty.stopping")) : duty.state === "stopped" ? banner("", tr("s15.state.stopped")) : "";
  return `<section class="s15-stall" aria-labelledby="s15-stall-${e(duty.id)}"><h4 class="s-section-t" id="s15-stall-${e(duty.id)}">${fill("s15.stall.title", { n: report.attempts.length })}</h4>
    <p class="s-sub">${codeText(`stall_${report.code}`)} · ${clock(report.at)}</p>${attempts}<p class="s-sub">${e(budgetWords(duty))}</p>${untrusted(`<p class="s15-text">${e(report.recommendation)}</p>`, tr("s15.decision.recommend"))}
    <p class="s-note">${tr("s15.stall.others_continue")}</p>${next}${choices}</section>`;
}

function stopForm(duty: ResponsibilityProjection, csrf: string, label: string): string {
  return form("/s15/forms/duty/stop", csrf, `${hidden("duty", duty.id)}<button class="s-btn">${e(label)}</button>`);
}

/** F9 ResponsibilityCard: the owner's words, subject, completion rule, current rules line, state and next step. */
export function dutyCard(duty: ResponsibilityProjection, csrf: string, detail = false): string {
  const state = dutyState(duty);
  const wait = duty.state === "waiting" && duty.wait ? `<p class="s15-wait">${tr(duty.wait.kind === "ci" ? "s15.duty.waiting_ci" : duty.wait.kind === "review" ? "s15.duty.waiting_review" : duty.wait.kind === "owner" ? "s15.duty.waiting_owner" : "s15.duty.waiting_schedule")} <span class="s-meta">${tr("s15.duty.since")} ${clock(duty.wait.since)}</span></p>` : "";
  const restart = duty.resumedAfterRestart && !["stopped", "completed"].includes(duty.state) ? `<p class="s-meta">${tr(duty.state === "reconcile_only" ? "s15.duty.restart_unknown" : "s15.duty.after_restart")}</p>` : "";
  const proposals = duty.proposals.length ? `<div class="s15-proposals"><h4 class="s-section-t">${tr("s15.duty.outside")}</h4><ul class="s15-facts">${duty.proposals.map(item => `<li>${item.evidenceRefs.map(ref => `<span class="s-mono">${e(ref)}</span>`).join(", ") || `<span class="s-mono">${e(item.eventId)}</span>`} <a class="s-link-text" href="/chats/${e(duty.conversationId)}?duty=${e(duty.id)}&amp;accept=${e(item.eventId)}#s15-text">${tr("s15.duty.accept_new")}</a></li>`).join("")}</ul><p class="s-note">${tr("s15.duty.proposal_note")}</p></div>` : "";
  const stop = !["stopped", "completed", "stopping", "paused"].includes(duty.state) && !duty.stopRequested ? ownerStrip(stopForm(duty, csrf, tr("s15.duty.stop")), fill("s15.duty.stop_scope", { name: name(duty), n: duty.stopImpact.otherResponsibilities })) : "";
  const stopping = duty.state === "stopping" && !duty.report ? banner("", tr("s15.duty.stopping")) : "";
  const attempts = detail && duty.attempts.length ? `<details class="s-more"><summary>${fill("s15.duty.attempts", { n: duty.attempts.length })}</summary><ol class="s15-attempts">${duty.attempts.map(a => `<li><p class="s15-text">${e(a.approach)}</p><p class="s-meta">${clock(a.startedAt)} · ${tr(key(`s15.duty.attempt.${a.state}`))} · ${tr(key(`s15.stall.progress.${a.progress}`))}${a.evidenceRefs.length ? ` · ${a.evidenceRefs.map(ref => `<span class="s-mono">${e(ref)}</span>`).join(", ")}` : ""}</p></li>`).join("")}</ol></details>` : "";
  return `<article class="s-workcard s15-duty" id="s15-duty-${e(duty.id)}" aria-labelledby="s15-duty-t-${e(duty.id)}"><div class="s-workcard-hd"><div><h3 id="s15-duty-t-${e(duty.id)}">${tr("s15.duty.title")}</h3>${duty.subject ? `<p class="s-meta s-mono">${e(duty.subject.startsWith("issue:") ? `#${duty.subject.slice(6)}` : duty.subject)}</p>` : ""}</div>${statePill(state)}</div>
    <div class="s-slip-body">${untrusted(`<p class="s15-text">${e(duty.originalText)}</p>`, tr("s15.duty.your_words"))}<dl class="s-kv"><dt>${tr("s15.duty.done_when")}</dt><dd class="s15-text">${e(duty.completion)}</dd><dt>${tr("s15.duty.triggers")}</dt><dd>${duty.triggers.map(t => tr(key(`s15.duty.trigger.${t}`))).join(" · ")}</dd></dl>
    ${wait}${restart}${stopping}${stallReport(duty, csrf)}${proposals}${attempts}${detail ? "" : `<p><a class="s-link-text" href="/duties/${e(duty.id)}">${tr("s15.duty.open")}</a></p>`}</div>${stop}</article>`;
}

/** `/work`: Needs you · Working · Waiting · Responsibilities · Recently done. Durable waits are separate from Needs you. */
export interface S15WorkRow { conversationId: string; requestId: string; ownerMessage: string; state: S15State; at: number }
export function workBody(input: { needs: number; duties: ResponsibilityProjection[] | null; working: S15WorkRow[]; waiting: S15WorkRow[]; done: S15WorkRow[]; csrf: string }): string {
  const row = (item: S15WorkRow) => `<li><a href="/chats/${e(item.conversationId)}#s15-row-${e(item.requestId)}"><span><span>${e(clip(item.ownerMessage, 80))}</span><small>${clock(item.at)}</small></span>${statePill(item.state)}</a></li>`;
  const section = (id: string, title: string, items: string, empty: string) => `<section class="s-attention-group" aria-labelledby="s15-work-${id}"><h2 id="s15-work-${id}">${title}</h2>${items ? `<ul class="s-attention">${items}</ul>` : `<p class="s-sub">${empty}</p>`}</section>`;
  const duties = input.duties;
  const waitingDuties = duties?.filter(d => d.state === "waiting" && d.wait && d.wait.kind !== "owner") ?? [];
  const waiting = [...input.waiting.map(row), ...waitingDuties.map(d => `<li><a href="/duties/${e(d.id)}"><span><span>${e(name(d))}</span><small>${tr(d.wait!.kind === "ci" ? "s15.duty.waiting_ci" : d.wait!.kind === "review" ? "s15.duty.waiting_review" : "s15.duty.waiting_schedule")}</small></span>${statePill(dutyState(d))}</a></li>`)].join("");
  const needs = `<section class="s-attention-group" aria-labelledby="s15-work-needs" id="needs"><h2 id="s15-work-needs">${tr("s15.nav.needs")}</h2><p>${input.needs ? `<a class="s-btn" href="/needs">${fill("s15.live.needs", { n: input.needs })}</a>` : `<span class="s-sub">${tr("s15.needs.none")}</span>`}</p></section>`;
  const dutyList = duties === null ? `<section class="s-attention-group"><h2>${tr("s15.duty.list_title")}</h2>${banner("", tr("s15.duty.not_composed"), tr("s15.common.not_available_detail"))}</section>`
    : `<section class="s-attention-group" aria-labelledby="s15-work-duties"><h2 id="s15-work-duties">${tr("s15.duty.list_title")}</h2>${duties.length ? duties.map(d => dutyCard(d, input.csrf)).join("") : `<p class="s-sub">${tr("s15.duty.none")}</p>`}</section>`;
  return `<div class="s-col s-attention-groups">${needs}${section("working", tr("s15.work.section_working"), input.working.map(row).join(""), tr("s15.work.none_working"))}${section("waiting", tr("s15.work.section_waiting"), waiting, tr("s15.work.none_waiting"))}${dutyList}${section("done", tr("s15.work.section_done"), input.done.map(row).join(""), tr("s15.work.none_done"))}</div>`;
}
export const dutyPill = (duty: ResponsibilityProjection) => pill(tr(key(`s15.state.${dutyState(duty)}`)));
