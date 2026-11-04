import { tr } from "../../i18n";
import { ownerStrip, untrusted } from "../../s14/web-pages";
import type { ConversationEvidence, ConversationOwnerRow, ConversationOwnerView } from "../conversation";
import { banner, clock, clockText, codeText, e, fill, form, hidden, icon, jitMark, experienceIcon, key, pill, statePill, type S15State } from "./render";
import type { S15MemoryClaim, S15ModelBudgetView, S15ReadinessReport } from "./types";
import type { ActionSlip } from "../policy";
import type { ResponsibilityProjection } from "../work";
import { compactSlip, slipHeading, webDecisionText, type S15SlipDecision } from "./actions";
import { limitNotice, loginCard, type S15BrowserInfo, type S15BrowserProgress } from "./browser";
import { dutyCard } from "./duties";

/** Per-row optional data from feature-detected slices; absent data renders nothing rather than a guess. */
export interface S15RowExtras { readiness: S15ReadinessReport | null; selection: S15ModelBudgetView["selections"][number] | null; pinned: boolean; memory: S15MemoryClaim[] }
/** Everything the conversation page needs. `draft` is only ever the owner's own refused or prefilled text. */
export interface S15ChatPage {
  csrf: string; conversationId: string; view: ConversationOwnerView | null; extras: Record<string, S15RowExtras>;
  /** `duty` names the paused responsibility a stall reply continues; WORK resumes it only after this message completes. */
  draft: { text: string; requestId: string | null; answer: { requestId: string; revision: number } | null; duty?: string } | null;
  refused: string | null; duplicate: ConversationOwnerRow | null; memoryAvailable: boolean;
  /** UX15-02: owner decision rows of this conversation, its responsibilities and its single configured website session. */
  decisions?: S15SlipDecision[]; duties?: ResponsibilityProjection[]; browser?: { browser: S15BrowserInfo; state: S15BrowserProgress | undefined } | null; canDecide?: boolean;
}

const active: ReadonlySet<ConversationOwnerRow["state"]> = new Set(["received", "understanding", "inspecting", "working"]);
/** Rows the owner may still stop. A stop narrows authority only; it is never an approval. */
const stoppable: ReadonlySet<ConversationOwnerRow["state"]> = new Set(["received", "understanding", "inspecting", "working", "question", "needs_you", "budget_hold"]);
export const liveRow = (row: ConversationOwnerRow) => active.has(row.state) || row.progress.active;
const subjectLabel = (subject: string | null) => subject?.startsWith("issue:") ? `#${subject.slice(6)}` : subject;

/** Pasted, quoted and fenced parts of the owner's own message are content, never instructions (S15-AC01). */
function ownerText(text: string): string {
  const parts: string[] = [], lines = text.split("\n");
  let plain: string[] = [], quoted: string[] = [], fence: string[] | null = null;
  const flush = () => {
    if (plain.length) { parts.push(`<p class="s15-text">${e(plain.join("\n"))}</p>`); plain = []; }
    if (quoted.length) { parts.push(untrusted(`<p class="s15-text">${e(quoted.join("\n"))}</p>`, tr("s15.untrusted.pasted"))); quoted = []; }
  };
  for (const line of lines) {
    if (fence) { fence.push(line); if (/^\s*(```|~~~)/.test(line)) { parts.push(untrusted(`<pre class="s-exact">${e(fence.join("\n"))}</pre>`, tr("s15.untrusted.pasted"))); fence = null; } continue; }
    if (/^\s*(```|~~~)/.test(line)) { flush(); fence = [line]; continue; }
    if (/^\s*>/.test(line)) { if (plain.length) flush(); quoted.push(line); continue; }
    if (quoted.length) flush();
    plain.push(line);
  }
  if (fence) plain.push(...fence);
  flush();
  return parts.join("");
}

/** ReceiptLine: rendered only from a committed receipt; there is never a checkmark for model completion. */
const receiptLine = (row: ConversationOwnerRow) => `<p class="s15-receipt">${tr("s15.receipt.received")} · ${clock(row.receipt.receivedAt)}</p>`;

/** IntentLine from admission/hold projections only. A held admission never reads as started. */
function intentLine(row: ConversationOwnerRow): string {
  const subject = subjectLabel(row.subject);
  if (row.intentLine === "report_only") return `<p class="s15-intent">${icon("info")}<span>${tr("s15.intent.inspect")}</span></p>`;
  if (row.intentLine === "started_work" && row.scopeLine) return `<p class="s15-intent">${icon("work")}<span>${tr("s15.intent.execute")}${subject ? ` · ${e(subject)}` : ""} · ${fill("s15.intent.under_rule", { n: row.scopeLine.policyRevision })}</span></p>`;
  if (row.intentLine === "obligation_only") return `<p class="s15-intent">${icon("clock")}<span>${tr("s15.intent.accepted_only")}</span></p>`;
  if (row.intentLine === "question" && row.state === "question") return `<p class="s15-intent">${icon("alert")}<span>${tr("s15.intent.question")}</span></p>`;
  if (row.intentLine === "question") return `<p class="s15-intent">${icon("alert")}<span>${tr("s15.intent.not_started")}</span></p>`;
  return "";
}

/** ScopeLine plus the read-only "Why Jit may do this" disclosure, from the admitted authority record. */
function scopeLine(row: ConversationOwnerRow): string {
  const scope = row.scopeLine; if (!scope) return "";
  const access = tr(key(`s15.scope.access.${scope.access}`));
  return `<div class="s15-scope"><p>${fill("s15.intent.under_rule", { n: scope.policyRevision })} · ${e(access)}</p><details class="s-more"><summary>${tr("s15.intent.why")}</summary><div><dl class="s-kv">
    <dt>${tr("s15.scope.rule")}</dt><dd>${fill("s15.intent.under_rule", { n: scope.policyRevision })}</dd><dt>${tr("s15.scope.purpose")}</dt><dd class="s-mono">${e(scope.purposeId)}</dd>
    <dt>${tr("s15.scope.resources")}</dt><dd>${scope.resources.length ? scope.resources.map(item => `<span class="s-mono">${e(item)}</span>`).join(" · ") : tr("s15.scope.no_resources")}</dd><dt>${tr("s15.scope.access")}</dt><dd>${e(access)}</dd>
    <dt>${tr("s15.scope.authority")}</dt><dd class="s-mono">${e(scope.authorityId)}</dd></dl><p class="s-note">${tr("s15.scope.note")}</p></div></details></div>`;
}

const vmTools: Record<string, string> = { bash: "s15.progress.tool.bash", read: "s15.progress.tool.read", write: "s15.progress.tool.write", edit: "s15.progress.tool.edit", ls: "s15.progress.tool.ls", find: "s15.progress.tool.find", grep: "s15.progress.tool.grep" };
/** One committed evidence row. Output is the tool's own report: VM output says so, nothing reads as verified outside. */
export function evidenceRow(item: ConversationEvidence, index: number): string {
  const vm = Object.hasOwn(vmTools, item.tool), verb = vm ? tr(key(vmTools[item.tool]!)) : fill("s15.progress.tool.other", { tool: item.tool });
  const state = item.isError ? pill(tr("s15.state.failed"), "danger", "×") : `<span class="s15-saved">✓ ${tr("s15.progress.saved")}</span>`;
  return `<li class="s15-evidence"><p class="s-row"><span class="s-grow">${e(verb)}</span>${state}<span class="s-meta">${clock(item.at)}</span></p>
    <details class="s-more"><summary>${tr(vm ? "s15.vm.output" : "s15.progress.output")} ${index + 1}</summary><div>${untrusted(`<pre class="s-exact">${e(item.content)}</pre>`, tr(vm ? "s15.vm.reported" : "s15.progress.output_untrusted"))}<p class="s-mono s-meta">${e(item.outputHash)}</p></div></details></li>`;
}

/** ProgressRegion: provisional phase first, then committed evidence. It never certifies completion. */
function progressRegion(row: ConversationOwnerRow): string {
  const phase = row.state === "stopped" ? "" : row.progress.active ? tr(row.progress.phase === "interpretation" ? "s15.progress.understanding" : row.progress.phase === "decision" ? "s15.progress.deciding" : "s15.progress.working")
    : row.state === "received" || row.state === "understanding" ? tr("s15.progress.waiting_start") : "";
  const evidence = row.evidence.slice(0, 64), shown = evidence.slice(0, 5), more = evidence.slice(5);
  const list = evidence.length ? `<ul class="s15-progress-list">${shown.map(evidenceRow).join("")}</ul>${more.length ? `<details class="s-more"><summary>${fill("s15.progress.show_all", { n: evidence.length })}</summary><ul class="s15-progress-list">${more.map((item, index) => evidenceRow(item, index + 5)).join("")}</ul></details>` : ""}` : "";
  if (!phase && !list) return "";
  return `<section class="s15-progress" aria-label="${tr("s15.progress.title")}"><h4 class="s-section-t">${tr("s15.progress.title")}</h4>${phase ? `<p class="s15-phase-line">${row.progress.active ? '<span class="s15-dot" aria-hidden="true"></span>' : ""}${e(phase)}</p>` : ""}${list}</section>`;
}

/** F3 ReadinessTable: system-sorted rows; Jit never picks one. Each ready row offers only a composer prefill. */
function readinessTable(report: S15ReadinessReport, conversationId: string): string {
  const safe = (href: string | null) => href && /^https:\/\/[^\s"'<>]+$/.test(href) ? href : null;
  const rows = report.rows.slice(0, 64).map(item => {
    const facts = item.facts.map(fact => { const link = safe(fact.href), text = `${fact.ok ? "✓" : "×"} ${tr(key(`s15.readiness.fact.${fact.kind}`))}: ${fact.detail}`;
      return `<li>${link ? `<a class="s-link-text" href="${e(link)}" rel="noreferrer noopener">${e(text)}</a>` : e(text)}</li>`; }).join("");
    const chip = item.state === "ready" ? `<a class="s-chip" href="/chats/${e(conversationId)}?start=${item.issue}#s15-text" data-prefill="${e(fill("s15.readiness.start_text", { issue: item.issue }))}">${tr("s15.readiness.do_this")}</a>` : "";
    return `<tr><th scope="row" class="s-mono">#${item.issue}</th><td><p class="s15-text">${e(item.title)}</p><ul class="s15-facts">${facts}</ul></td><td>${pill(tr(key(`s15.readiness.state.${item.state}`)), item.state === "ready" ? "ok" : "warn", item.state === "ready" ? "✓" : "!")}</td><td>${chip}</td></tr>`;
  }).join("");
  return `<section class="s15-readiness" aria-label="${tr("s15.readiness.title")}"><h4 class="s-section-t">${tr("s15.readiness.title")} · <span class="s-mono">${e(report.repository)}</span></h4><div class="s15-table-wrap"><table class="s15-table"><thead><tr><th scope="col">${tr("s15.readiness.issue")}</th><th scope="col">${tr("s15.readiness.reasons")}</th><th scope="col">${tr("s15.readiness.state")}</th><th scope="col"><span class="sr-only">${tr("s15.readiness.do_this")}</span></th></tr></thead><tbody>${rows}</tbody></table></div><p class="s-note">${tr("s15.readiness.no_pick")}</p></section>`;
}

/** The pill shown on the card. Work that reports done without any committed evidence stays out of `done`. */
export function displayState(row: ConversationOwnerRow): S15State {
  if (row.state === "done" && row.intentLine && row.intentLine !== "obligation_only" && row.evidence.length === 0) return "partial";
  return row.state;
}

/** ResultBlock: status, Jit's answer as untrusted data, gaps and what the owner can unblock. */
function resultBlock(row: ConversationOwnerRow, extras: S15RowExtras | undefined, conversationId: string, page?: S15ChatPage): string {
  const parts: string[] = [];
  if (row.result) parts.push(untrusted(`<p class="s15-text" id="s15-answer-${e(row.requestId)}">${e(row.result.text)}</p>`, tr("s15.result.answer")));
  if (extras?.readiness) parts.push(readinessTable(extras.readiness, conversationId));
  else if (row.state === "question" && row.intentLine === "report_only") parts.push(`<p class="s-note">${tr("s15.readiness.no_pick")} ${tr("s15.readiness.tell_me")}</p>`);
  const work = row.intentLine === "report_only" || row.intentLine === "started_work";
  if (work && (row.result || ["done", "blocked", "stopped", "unknown", "partial"].includes(row.state)) && row.evidence.length === 0) parts.push(`<div class="s15-gaps"><h4 class="s-section-t">${tr("s15.result.gaps")}</h4><p>${tr("s15.result.no_evidence")}</p></div>`);
  if (row.state === "stopped") parts.push(banner("", tr("s15.state.stopped"), tr("s15.work.stopped_detail")));
  if (page && row.state === "unsupported") { parts.push(limitNotice(row.needsYou?.code ?? null, conversationId, row.requestId, page.browser?.browser ?? null, page.csrf)); return `<div class="s15-result">${parts.join("")}</div>`; }
  if (page && row.needsYou?.code === "login_required") { parts.push(page.browser ? loginCard(page.browser.browser, page.browser.state, page.csrf, conversationId) : `<p><a class="s-link-text" href="/resources/accounts#s15-res-sites">${tr("s15.browser.open_sites")}</a></p>`); return `<div class="s15-result">${parts.join("")}</div>`; }
  if (["blocked", "unsupported", "unknown", "budget_hold", "needs_you"].includes(row.state) && !row.needsYou?.slip) parts.push(banner(row.state === "unknown" ? "danger" : "warn", tr(key(`s15.state.${row.state}`)), codeText(row.needsYou?.code ?? null), row.needsYou ? `<p><a class="s-link-text" href="/needs#${e(row.needsYou.id)}">${tr("s15.result.needs_you")}</a></p>` : ""));
  return parts.length ? `<div class="s15-result">${parts.join("")}</div>` : "";
}

/** Latest revision of every action this request prepared; older revisions stay reachable from the slip's diff. */
export const latestSlips = (slips: readonly ActionSlip[]) => [...slips.reduce((map, slip) => { const seen = map.get(slip.action.id); if (!seen || slip.action.revision > seen.action.revision) map.set(slip.action.id, slip); return map; }, new Map<string, ActionSlip>()).values()];
/** Compact ActionSlips in the thread; the decision happens on the full slip under its complete exact content (F4). */
function heldNotice(row: ConversationOwnerRow, page: S15ChatPage): string {
  const slips = latestSlips(row.slips); if (!slips.length) return "";
  return `<div class="s15-held-list">${slips.map(slip => compactSlip(slip, (page.decisions ?? []).filter(item => item.row.decision?.action.id === slip.action.id))).join("")}</div>`;
}
/** Every pending approvable slip in the thread, for the "which one?" reply. */
const pendingSlips = (page: S15ChatPage) => latestSlips((page.view?.rows ?? []).flatMap(row => row.slips)).filter(slip => slip.state === "pending" && slip.canApprove);
/** A decision row: the owner's own decision on one exact revision, with a link to that slip, never a work card. */
function decisionRow(row: ConversationOwnerRow, page: S15ChatPage): string {
  const decision = row.decision!, slip = (page.view?.rows ?? []).flatMap(item => item.slips).find(item => item.action.id === decision.action.id && item.action.revision === decision.action.revision);
  const label = fill(decision.decision === "approve" ? "s15.hold.decided_approve" : "s15.hold.decided_deny", { n: decision.action.revision });
  const message = webDecisionText(row) ? `<p class="s15-decision-line">${icon("lock")}<span>${e(label)}${slip ? ` · ${e(slipHeading(slip))}` : ""}</span></p>` : `<div class="s-owner-msg">${ownerText(row.ownerMessage)}</div>`;
  const outcome = decision.outcome === "unknown" ? statePill("unknown") : decision.outcome === "succeeded" ? statePill("done") : decision.outcome === "failed" || decision.outcome === "not_dispatched" ? statePill("failed") : decision.decision === "deny" ? statePill("denied") : statePill("working");
  return `<div class="s15-row" id="s15-row-${e(row.requestId)}" data-region data-sig="${row.revision}-${row.state}-${decision.outcome ?? ""}" data-phase="${e(row.state)}">${message}${receiptLine(row)}<p class="s-row">${outcome}<a class="s-link-text" href="/actions/${e(decision.action.id)}?r=${decision.action.revision}">${tr("s15.slip.open")}</a></p></div>`;
}
/** Held text decision that could not bind: several pending items, or the item changed since it was shown. */
function decisionHold(row: ConversationOwnerRow, page: S15ChatPage): string {
  const code = row.needsYou?.code;
  if (code === "approval_reference_required") {
    const pending = pendingSlips(page);
    return `<div class="s15-question" role="group" aria-label="${tr("s15.hold.which")}"><p><b>${tr("s15.hold.which")}</b></p>${pending.length ? `<ul class="s15-facts">${pending.map(slip => `<li><a class="s-link-text" href="/actions/${e(slip.action.id)}">${e(slipHeading(slip))} · r${slip.action.revision}</a></li>`).join("")}</ul>` : `<p class="s-sub">${tr("s15.hold.none_pending")}</p>`}<p class="s-note">${tr("s15.hold.nothing_ran")}</p></div>`;
  }
  if (code === "stale_action") return `<div class="s15-question" role="note"><p><b>${tr("s15.hold.changed_reply")}</b></p><p class="s-note">${tr("s15.hold.nothing_ran")}</p></div>`;
  return "";
}

/** QuestionCard: one missing datum; chips prefill the composer and only the sent message resolves the hold. */
function questionCard(row: ConversationOwnerRow, conversationId: string): string {
  if (row.state !== "question" || !row.question) return "";
  const chips = row.question.candidates.map((candidate, index) => `<a class="s-chip" href="/chats/${e(conversationId)}?answer=${e(row.requestId)}&amp;pick=${index}#s15-text" data-prefill="${e(fill("s15.question.reply_text", { choice: candidate }))}" data-answer="${e(row.requestId)}" data-revision="${row.revision}">${e(candidate)}</a>`).join("");
  return `<div class="s15-question" role="group" aria-label="${tr("s15.intent.question")}"><p><b>${codeText(row.needsYou?.code ?? "material_ambiguity")}</b></p>${chips ? `<div class="s15-chips">${chips}</div>` : ""}<p class="s-note"><a class="s-link-text" href="#s15-text">${tr("s15.question.own_words")}</a></p></div>`;
}

/** ReplyFooter: recorded model selection, retained memory and receipt details. */
function replyFooter(row: ConversationOwnerRow, extras: S15RowExtras | undefined, memoryAvailable: boolean, conversationId: string): string {
  const parts: string[] = [], selection = extras?.selection;
  if (row.result || row.evidence.length) parts.push(`<a class="s-link-text" href="/library?conversation=${e(conversationId)}&amp;request=${e(row.requestId)}" data-s15-detail>${tr("s15.library.open")}${row.evidence.length ? ` · ${row.evidence.length}` : ""}</a>`);
  if (row.result) parts.push(`<a class="s-link-text" href="/chats/${e(conversationId)}?quote=${e(row.requestId)}#s15-text" data-s15-quote="${e(row.requestId)}">${tr("s15.composer.quote")}</a>`);
  if (selection) {
    const effort = tr(key(`s15.model.effort.${selection.effort.requested}`));
    parts.push(`<details class="s-more s15-model"><summary>${fill("s15.model.used", { model: selection.route.modelId, effort })}</summary><div><p>${extras!.pinned || selection.reason === "owner_pin" ? tr("s15.model.pinned") : fill("s15.model.why", { reason: tr(key(`s15.model.reason.${selection.reason}`)) })}</p><p class="s-note">${tr("s15.model.effort_unproven")}</p><p class="s-meta"><span class="s-mono">${e(selection.route.provider)} · ${e(selection.route.modelId)}</span></p></div></details>`);
  }
  const retained = extras?.memory ?? [];
  if (memoryAvailable && retained.length) parts.push(`<details class="s-more s15-memory-note"><summary>${fill("s15.memory.retained", { n: retained.length })}</summary><ul class="s15-claims">${retained.map(claim => `<li><p class="s15-text">${e(claim.text)}</p><p class="s-meta">${pill(tr(claim.kind === "fact" ? "s15.memory.fact" : "s15.memory.inference"))} · ${tr(key(`s15.memory.source.${claim.provenance.origin.kind}`))}</p><p class="s-row"><a class="s-link-text" href="/memory?claim=${e(claim.id)}#s15-claim-${e(claim.id)}">${tr("s15.memory.correct")}</a><a class="s-link-text" href="/memory?forget=${e(claim.id)}#s15-claim-${e(claim.id)}">${tr("s15.memory.forget")}</a></p></li>`).join("")}</ul></details>`);
  parts.push(`<details class="s-receipt"><summary>${tr("s15.receipt.details")}</summary><p>${tr("s15.receipt.received")} ${clock(row.receipt.receivedAt)}</p><p class="s-mono">${e(row.receipt.requestId)}</p>${row.receipt.rootRequestId !== row.receipt.requestId ? `<p class="s-mono">${tr("s15.receipt.root")} ${e(row.receipt.rootRequestId)}</p>` : ""}</details>`);
  return `<div class="s15-footer">${parts.join("")}</div>`;
}

function stopStrip(row: ConversationOwnerRow, csrf: string): string {
  if (!stoppable.has(row.state)) return "";
  return `<div class="s-slip" data-state="closed">${ownerStrip(form("/s15/forms/stop", csrf, `${hidden("target", row.requestId)}<button class="s-btn">${icon("stop")}${tr("s15.work.stop")}</button>`), tr("s15.work.stop_note"))}</div>`;
}

/** One owner message and everything grounded from its committed records, in a stable region. */
export function rowHtml(row: ConversationOwnerRow, page: S15ChatPage): string {
  if (row.decision) return decisionRow(row, page);
  const extras = page.extras[row.requestId], state = displayState(row);
  const duties = (page.duties ?? []).filter(duty => duty.sourceRequestId === row.requestId).map(duty => dutyCard(duty, page.csrf)).join("");
  const held = !row.slips.length && (row.needsYou?.code === "approval_reference_required" || row.needsYou?.code === "stale_action") ? decisionHold(row, page) : "";
  const work = row.intentLine === "report_only" || row.intentLine === "started_work" || (row.scopeLine !== null && row.intentLine !== null);
  const answer = !work && row.result ? `<div class="s-bot-msg"><div>${untrusted(`<p class="s15-text" id="s15-answer-${e(row.requestId)}">${e(row.result.text)}</p>`, tr("s15.result.answer"))}</div></div>` : "";
  const card = work ? `<article class="s-workcard s15-work" aria-labelledby="s15-work-${e(row.requestId)}"><div class="s-workcard-hd"><div><h3 id="s15-work-${e(row.requestId)}">${tr(row.intentLine === "report_only" ? "s15.work.title_inspect" : "s15.work.title")}</h3>${row.subject ? `<p class="s-meta s-mono">${e(subjectLabel(row.subject)!)}</p>` : ""}</div>${statePill(state)}</div>
    ${scopeLine(row)}${progressRegion(row)}${resultBlock(row, extras, page.conversationId, page)}${heldNotice(row, page)}${stopStrip(row, page.csrf)}</article>`
    : `${!answer && row.state !== "done" && !held ? `<p class="s-row">${statePill(state)}</p>` : ""}${answer}${held || resultBlock({ ...row, result: null }, extras, page.conversationId, page)}${heldNotice(row, page)}${row.state === "question" ? "" : stopStrip(row, page.csrf)}`;
  return `<div class="s15-row" id="s15-row-${e(row.requestId)}" data-region data-sig="${row.revision}-${row.state}-${row.evidence.length}-${row.result ? 1 : 0}-${row.slips.map(slip => `${slip.action.revision}${slip.state}`).join(".")}"${liveRow(row) ? ' data-active="true"' : ""} data-phase="${e(row.state)}">
    <div class="s-owner-msg">${ownerText(row.ownerMessage)}</div>${receiptLine(row)}${row.reply === null ? "" : `<div class="s-owner-msg s15-reply">${ownerText(row.reply)}</div>`}<p class="s15-author">${jitMark()}<span>${tr("s14.jit")}</span></p>${intentLine(row)}${questionCard(row, page.conversationId)}${card}${duties}${replyFooter(row, extras, page.memoryAvailable, page.conversationId)}</div>`;
}

/** The latest material clarification hold, which a composer reply may answer as a continuation. */
export const openQuestion = (view: ConversationOwnerView | null) => { const row = view?.rows.at(-1); return row && row.state === "question" && row.question ? row : null; };

/** Composer without a Work switch, limit fields or grant choices (S15-D01). Enter sends; Shift+Enter is a newline. */
export function composer(page: S15ChatPage): string {
  const question = openQuestion(page.view), answer = page.draft?.answer ?? (question ? { requestId: question.requestId, revision: question.revision } : null);
  const reply = answer ? `<label class="s-chip s15-answer"><input type="checkbox" name="answer" value="${e(answer.requestId)}" checked>${hidden("answerRevision", answer.revision)}<span>${tr("s15.question.answering")}</span></label>` : "";
  return `<form class="s-composer s15-composer" id="s15-composer" data-composer data-region data-conversation="${e(page.conversationId)}" method="post" action="/s15/forms/message" novalidate>${hidden("csrf", page.csrf)}${hidden("requestId", page.draft?.requestId ?? crypto.randomUUID().replaceAll("-", ""))}${hidden("conversationId", page.conversationId)}${page.draft?.duty ? `${hidden("duty", page.draft.duty)}<p class="s-chip s15-duty-reply">${tr("s15.duty.replying")}</p>` : ""}
    ${page.refused ? `<div role="alert">${banner("warn", tr("s15.composer.refused_kept"), codeText(page.refused), `<p class="s-mono s-meta">${e(page.refused)}</p>`)}</div>` : ""}
    <label class="sr-only" for="s15-text">${tr("s15.composer.label")}</label><textarea id="s15-text" name="text" rows="2" maxlength="16384" placeholder="${tr("s15.composer.placeholder")}">${e(page.draft?.text ?? "")}</textarea>
    <div class="s-bar"><details class="s15-attachment-limit"><summary aria-label="${tr("s15.composer.attach")}">${experienceIcon("attach")}</summary><p class="s-note">${tr("s15.composer.attach_unavailable")}</p></details><span class="s-chip"><span aria-hidden="true">${tr("s15.composer.to")}</span><span class="sr-only">${tr("s15.composer.to")} </span> ${tr("s14.jit")}</span>${reply}<span class="s-grow"></span><span class="s15-sending" data-sending hidden role="status">${tr("s15.composer.sending")}</span><button class="s-send" aria-label="${tr("s15.composer.send")}">${icon("arrow")}</button></div>
    <p class="s15-unknown" data-unknown hidden role="alert">${tr("s15.composer.unknown_receipt")}</p><p class="s15-unknown" data-refused hidden role="alert" data-fallback="${tr("s15.composer.refused_kept")}"></p>
    <div class="s-draft-bar" data-draft-bar hidden><span data-draft-status role="status" data-saved="${tr("s14.plain.draft_saved")}" data-restored="${tr("s14.plain.draft_restored")}" data-sensitive="${tr("s15.composer.draft_sensitive")}" data-unavailable="${tr("s14.plain.draft_unavailable")}"></span><button class="s-link-text" type="button" data-draft-clear>${tr("s14.plain.draft_clear")}</button></div></form><p class="s15-composer-note">${tr("s15.composer.keyboard_hint")}</p>`;
}

/** The conversation column: rows in commit order, then the duplicate/refusal state the owner just caused. */
export function threadHtml(page: S15ChatPage): string {
  const rows = page.view?.rows ?? [];
  const duplicate = page.duplicate ? `<div role="status">${banner("", fill("s15.receipt.duplicate", { time: `${clockText(page.duplicate.receipt.receivedAt)} UTC` }))}</div>` : "";
  const empty = rows.length ? "" : `<section class="s-empty-thread">${jitMark()}<h2>${tr("s15.chat.empty")}</h2><p class="s-note">${tr("s15.chat.empty_note")}</p></section>`;
  return `<div class="s-col"><div class="s-thread s15-thread" id="s15-thread">${empty}${rows.map(row => rowHtml(row, page)).join("")}<div id="latest" tabindex="-1"></div>${duplicate}</div></div>`;
}
