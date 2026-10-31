import { tr, trMaybe } from "../i18n";
import type { Effect } from "./authority-types";
import type { GitAction, GitProgress } from "./coding-git-types";
import { gitPullUrl } from "./coding-git-remote";
import type { S14Page } from "./web";
import { banner, botName, commandForm, e, effectHistory, effectPill, k, notice, ownerStrip, pill, remaining, shell, when } from "./web-pages";
import { checksBlock, diffBlock, exactBlock } from "./web-coding";
import { reach } from "./web-memory";
import { gitAction, type S14GitCard, type S14WorkCoding } from "./web-product-coding";
import type { S14View } from "./web-product";
import { statementBanner, statementBlock, statementStrip } from "./web-statement";

/* Exact push and PR card (F9, F10 and CODE14-02). The decision sits under the diff and the checks, on this page only. A failed PR can stand beside a pushed branch, so push and PR are two facts. Unknown offers read-back or a statement, and no control here can send again. */
const reasonWord = (code: string | null) => code ? trMaybe(`s14.git.reason.${code}`) ?? tr("s14.git.reason.generic") : "";
const reasonLine = (code: string | null) => code ? `<p class="s-mono s-meta">${e(code)}</p>` : "";
const pushedReasons = ["git_pr_rejected_after_push", "git_pr_unconfirmed_after_push", "git_pr_precondition_unconfirmed_after_push"];
type Word = [string, string, string];
/** What is known about the branch. It reads only the durable stage: a stage that cannot prove a push stays unknown or not done. */
function pushFact({ stage, reason }: GitProgress): Word {
  if (stage === "complete") return ["pushed_read_back", "ok", "✓"];
  if (stage === "pushed" || stage === "pr_dispatching" || pushedReasons.includes(reason ?? "")) return ["pushed_reported", "strong", ""];
  if (stage === "unknown") return ["unknown", "danger", "?"];
  return [stage === "failed" ? "not_pushed" : "not_yet", "", ""];
}
function prFact({ stage, reason }: GitProgress, action: GitAction): Word {
  if (!action.pr) return ["pr_none", "", ""];
  if (stage === "complete") return ["pr_read_back", "ok", "✓"];
  if (reason === "git_pr_rejected_after_push") return ["pr_refused", "danger", "×"];
  if (stage === "unknown") return ["unknown", "danger", "?"];
  return [stage === "failed" ? "pr_not_opened" : "not_yet", "", ""];
}
const factPill = ([word, tone, glyph]: Word) => pill(tr(k(`s14.git.fact.${word}`)), tone, glyph);
function outcomeFacts(card: S14GitCard): string {
  const { action, progress } = card, row = (label: string, value: string) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const url = gitPullUrl(progress.pullUrl, action.repository.url, progress.pullNumber);
  const pullNumber = progress.pullNumber === null ? "" : url ? `<a class="s-link-text s-mono" href="${e(url)}" rel="noreferrer">#${progress.pullNumber}</a>` : `<span class="s-mono">#${progress.pullNumber}</span>`;
  return `<dl class="s-facts" aria-label="${tr("s14.git.facts")}">${row(tr("s14.git.fact_push"), factPill(pushFact(progress)))}${row(tr("s14.git.fact_pr"), `${factPill(prFact(progress, action))}${pullNumber}`)}${row(tr("s14.git.fact_check"), pill(tr(k(`s14.git.verification.${progress.verification}`)), progress.verification === "remote_readback" ? "strong" : ""))}${row(tr("s14.git.fact_merge"), pill(tr("s14.git.fact.no_merge")))}</dl>`;
}
const stages: GitProgress["stage"][] = ["prepared", "verifying", "push_dispatching", "pushed", "pr_dispatching", "complete"];
/** Steps of one approved plan. A step reads done only when the stored stage has passed it. */
function stageList(progress: GitProgress, action: GitAction): string {
  const shown = stages.filter(stage => action.pr || stage !== "pr_dispatching"), reached = shown.indexOf(progress.stage);
  const word = (index: number) => index < reached ? "done" : index === reached ? "now" : "later";
  return `<ol class="s-steps">${shown.map((stage, index) => `<li data-step="${word(index)}"><span>${tr(k(`s14.git.stage.${stage}`))}</span><small>${tr(k(`s14.life.step_word.${word(index)}`))}</small></li>`).join("")}</ol>`;
}
/** Each state in words. Nothing here reads as merged, and only a real read-back reads as confirmed. */
function stateBanner(effect: Effect, card: S14GitCard): string {
  const { progress } = card, code = progress.reason;
  if (effect.state === "unknown") return effect.resolution ? statementBanner(effect) : banner("danger", tr("s14.effect_state.unknown"), tr("s14.git.unknown_detail"), `<p class="s-sub">${e(reasonWord(code))}</p>${reasonLine(code)}<p class="s-sub">${tr("s14.git.unknown_next")}</p>`);
  if (effect.state === "failed") return banner("danger", tr("s14.effect_state.failed"), reasonWord(code) || tr("s14.git.failed_detail"), `${reasonLine(code)}<p class="s-sub">${tr(pushedReasons.includes(code ?? "") ? "s14.git.failed_pushed" : "s14.git.failed_nothing")}</p>`);
  if (effect.state === "succeeded") return banner("ok", tr("s14.effect_state.succeeded"), tr(progress.verification === "remote_readback" ? "s14.git.succeeded_detail" : "s14.git.succeeded_unverified"));
  if (effect.state === "expired") return banner("", tr("s14.effect_state.expired"), tr("s14.git.expired_detail"));
  if (effect.state === "denied") return banner("", tr("s14.effect_state.denied"), tr("s14.git.denied_detail"));
  if (effect.state === "approved") return banner("", tr("s14.effect_state.approved"), tr("s14.git.approved_detail"));
  if (effect.state === "executing") return banner("", tr("s14.effect_state.executing"), tr("s14.git.executing_detail"));
  return "";
}
/** The exact action in order: destination, branch, commits, connection, then the exact PR text. Full hashes, never shortened. */
function exactAction(card: S14GitCard): string {
  const { action, connection } = card, row = (label: string, value: string, mono = true) => `<dt>${label}</dt><dd${mono ? ' class="s-mono"' : ""}>${value}</dd>`;
  const label = connection ? `${e(connection.label)} <span class="s-mono s-meta">r${action.connection.revision}</span>` : `<span class="s-mono">${e(action.connection.id)} · r${action.connection.revision}</span>`;
  const pr = action.pr ? `<section class="s-stack" aria-labelledby="s14-git-pr"><h3 class="s-section-t" id="s14-git-pr">${tr("s14.git.pr_exact")}</h3><dl class="s-kv">${row(tr("s14.git.pr_base"), e(action.pr.base))}${row(tr("s14.git.pr_base_commit"), e(action.pr.baseCommit))}${row(tr("s14.git.pr_kind"), tr(action.pr.draft ? "s14.git.pr_draft" : "s14.git.pr_ready"), false)}</dl>${exactBlock(tr("s14.git.pr_title"), action.pr.title)}${exactBlock(tr("s14.git.pr_body"), action.pr.body || tr("s14.git.pr_body_empty"))}</section>` : `<p class="s-sub">${tr("s14.git.no_pr")}</p>`;
  return `<section class="s-stack" aria-labelledby="s14-git-exact"><h3 class="s-section-t" id="s14-git-exact">${tr("s14.git.exact")}</h3>${exactBlock(tr("s14.effect.destination"), action.repository.url)}<dl class="s-kv">${row(tr("s14.git.branch"), e(action.update.ref))}${row(tr("s14.git.old_commit"), action.update.oldCommit ? e(action.update.oldCommit) : tr("s14.git.new_branch"), !!action.update.oldCommit)}${row(tr("s14.coding.head_commit"), e(action.update.newCommit))}${row(tr("s14.coding.base_commit"), e(action.repository.baseCommit))}${row(tr("s14.git.connection"), label, false)}</dl>${pr}</section>`;
}
function binding(page: S14Page, effect: Effect, card: S14GitCard): string {
  const { action } = card, pending = effect.state === "pending";
  return `<dl class="s-kv"><dt>${tr("s14.effect.revision")}</dt><dd class="s-mono">r${effect.revision}</dd><dt>${tr("s14.effect.hash")}</dt><dd class="s-mono">${e(effect.actionHash)}</dd><dt>${tr("s14.coding.diff_hash")}</dt><dd class="s-mono">${e(action.diffHash)}</dd><dt>${tr("s14.effect.expires")}</dt><dd>${when(effect.expiresAt)}${pending ? ` · ${remaining(effect.expiresAt, page.now)}` : ""}</dd></dl><details class="s-more"><summary>${tr("s14.git.payload")}</summary><div><pre class="s-exact">${e(effect.action.content)}</pre></div></details>`;
}
/** Evidence the card binds to: both must still be the record this action names, or the owner has nothing to review. */
const evidenceHolds = (coding: S14WorkCoding, action: GitAction) => coding.view.available && !!coding.diff && coding.run?.diffHash === action.diffHash && coding.run?.headCommit === action.headCommit;
function evidence(card: S14GitCard, open: boolean): string {
  const { coding, action } = card, run = coding.run, weak = run?.state !== "reviewable" ? banner("warn", tr("s14.git.tests_weak"), tr("s14.git.tests_weak_detail")) : "";
  if (!evidenceHolds(coding, action)) return banner("warn", tr("s14.git.evidence_gone"), tr("s14.git.evidence_gone_detail"));
  return `${weak}${checksBlock(coding, false, open)}${diffBlock(coding)}<p><a class="s-link-text" href="/work/${e(run!.workId)}?tab=report&amp;report=${e(action.reportId)}">${tr("s14.git.open_report")}</a></p>`;
}
const approveLabel = (effect: Effect, action: GitAction) => `${tr(action.pr ? "s14.git.approve_pr" : "s14.git.approve_push")} · ${effect.actionHash.slice(0, 8)}`;
/** The approval press. Its label names the action, the count and the hash; no merge sits behind it. */
function decision(page: S14Page, effect: Effect, card: S14GitCard): string {
  const decide = (choice: "approve" | "deny", label: string, cls: string) => commandForm(page.csrf, "approval.decide", effect.revision, { effectId: effect.id, actionHash: effect.actionHash, decision: choice }, label, cls);
  const ready = effect.supported && evidenceHolds(card.coding, card.action);
  return ownerStrip(`${ready ? decide("approve", approveLabel(effect, card.action), "s-btn primary") : ""}${decide("deny", tr("s14.effect.deny"), "s-btn")}`, tr(effect.supported ? "s14.git.approve_note" : "s14.effect.unsupported"), "", `<p class="s-note">${tr("s14.git.changed_note")}</p>`);
}
/** Read-back is the only Git action on an unknown card. It asks GitHub what is there and cannot push or open anything. */
function readBackStrip(page: S14Page, effect: Effect, card: S14GitCard): string {
  if (effect.state !== "unknown") return "";
  if (card.reconcileRequested) return `<div class="s-slip-body">${banner("", tr("s14.git.reading"), tr("s14.git.reading_detail"))}</div>`;
  if (card.readBack !== "ok") return `<div class="s-slip-body">${banner("warn", tr("s14.git.read_blocked"), tr(k(`s14.git.read_blocked.${card.readBack}`)))}</div>`;
  return ownerStrip(commandForm(page.csrf, "git.reconcile", effect.revision, { effectId: effect.id, actionHash: effect.actionHash }, tr("s14.git.read_back")), tr("s14.git.read_back_note"));
}
const heading = (page: S14Page, effect: Effect) => `${e(botName(page.state.bots.find(bot => bot.id === effect.botId) ?? { id: effect.botId, name: effect.botId }))} ${tr("s14.effect.asks")} ${e(tr(k(`s14.effect_kind.${effect.action.kind}`)))}`;
const slipState = (effect: Effect) => effect.state === "unknown" ? "unknown" : effect.state === "pending" ? "pending" : "closed";
/** Inline form of a push card: the state and where it goes, then a link. Nothing can be decided away from the diff. */
export function gitSummarySlip(page: S14Page, effect: Effect): string {
  const action = gitAction(effect)!;
  return `<article class="s-slip" data-state="${slipState(effect)}" aria-label="${tr("s14.effect.card")}"><div class="s-slip-hd"><div><h3>${heading(page, effect)}</h3><p class="s-meta">${tr("s14.effect.irreversible")}</p></div>${effectPill(effect.state)}</div><div class="s-slip-body"><p class="s-mono">${e(action.update.ref)}</p><p class="s-mono s-meta">${e(effect.actionHash.slice(0, 16))}</p><p class="s-note">${tr("s14.git.no_merge")}</p><p><a class="s-btn" href="/effects/${e(effect.id)}#slip">${tr(effect.state === "pending" || effect.state === "unknown" ? "s14.git.open_card" : "s14.git.see_card")}</a></p></div></article>`;
}
/** True while this page rereads itself. Its heading takes no focus then, because live reads wait for a focused region. */
const followed = (effect: Effect, card: S14GitCard) => effect.state === "approved" || effect.state === "executing" || card.reconcileRequested;
function fullSlip(page: S14Page, view: Extract<S14View, { kind: "effect" }>, card: S14GitCard): string {
  const { effect } = view, pending = effect.state === "pending", moving = effect.state === "approved" || effect.state === "executing";
  const body = `${stateBanner(effect, card)}${moving ? stageList(card.progress, card.action) : ""}${pending ? "" : outcomeFacts(card)}${statementBlock(effect)}${exactAction(card)}${binding(page, effect, card)}${evidence(card, pending)}${reach(card.action.pr ? ["s14.git.does_push", "s14.git.does_pr"] : ["s14.git.does_push"], ["s14.git.not_merge", "s14.git.not_deploy", "s14.git.not_more"])}`;
  const strips = pending ? decision(page, effect, card) : `${readBackStrip(page, effect, card)}${statementStrip(page, effect, true, view.draft ?? null)}`;
  return `<article class="s-slip" data-state="${slipState(effect)}" aria-label="${tr("s14.effect.card")}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1"${followed(effect, card) ? "" : " data-focus-on-load"}>${heading(page, effect)}</h2><p class="s-meta">${tr("s14.effect.irreversible")}</p></div>${effectPill(effect.state)}</div><div class="s-slip-body">${body}</div>${strips}</article>`;
}
/** The card's own page. It follows a running push by itself, and every decision on it stays a plain form post. */
export function gitEffectPage(page: S14Page, view: Extract<S14View, { kind: "effect" }>, card: S14GitCard): string {
  const { effect } = view, live = followed(effect, card), requested = card.receipt && !card.reconcileRequested ? banner("", tr("s14.git.read_done"), tr("s14.git.read_done_detail")) : "";
  const content = `<span hidden data-phase="${e(tr(k(`s14.effect_state.${effect.state}`)))}"></span>${requested}${fullSlip(page, view, card)}`;
  return shell(page, tr("s14.effect.card"), `<div class="s-col">${view.saved ? banner("", tr("s14.statement.saved"), tr("s14.statement.saved_detail")) : ""}${notice(view.notice ?? null)}<div class="s-stack" id="s14-live">${content}</div>${effectHistory(view.history, effect)}<p><a class="s-link-text" href="/work/${e(effect.workId)}?tab=coding">${tr("s14.effect.back_to_work")}</a></p></div>`, { current: "work", live });
}
