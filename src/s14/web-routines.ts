import { currentLocale, tr, trMaybe } from "../i18n";
import type { Bot, Route } from "./types";
import type { AttentionNotice, Routine, RoutineOccurrence, RoutinePurpose, RoutineView } from "./routine-types";
import type { ScopeRef } from "./authority-types";
import type { S14Page } from "./web";
import { accountChoices, banner, botName, commandForm, dismissForm, e, hidden, icon, k, limitFields, notice, ownerStrip, pill, routeText, shareChoices, shell, size, untrusted, when } from "./web-pages";
import { reach } from "./web-memory";
import { generalTool } from "./web-product-coding";
import { ownerStoppedRun, routineBounds, type S14RoutineDetail, type S14RoutineDraft, type S14RoutineFinding, type S14RoutineList, type S14RoutineNew, type S14RoutineReview, type S14RoutineSurface } from "./web-product-routines";

/* Routines (ROUT14-01, F13). A routine is an authorization written as sentences: fixed words and typed data, with the owner's text and anything a run found kept in a frame. Titles never reach a heading, a button or a strip. */
const stateTone: Record<Routine["state"], [string, string]> = { active: ["strong", ""], paused: ["", ""], revoked: ["", ""], exhausted: ["", ""], blocked: ["warn", "!"] };
const statePill = (state: Routine["state"]) => pill(tr(k(`s14.routine.state.${state}`)), ...stateTone[state]);
/** Text a deletion erased reads as deleted rather than as the placeholder the seam leaves. */
const text = (value: string) => value === "[deleted]" ? tr("s14.routine.text_deleted") : value;
const reasonWord = (code: string | null) => (code ? trMaybe(`s14.routine.reason.${code}`) ?? trMaybe(`s14.reason.${code}`) : null) ?? tr("s14.routine.reason.generic");

/** One instant in the routine's own zone, because the zone is part of what the owner authorized. */
function whenIn(value: number, timezone: string, weekday = false): string {
  const date = new Date(value), format = new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { ...(weekday ? { weekday: "short" as const } : {}), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timezone });
  return `<time datetime="${date.toISOString()}">${e(format.format(date))}</time>`;
}
function recurrenceText(payload: Pick<RoutinePurpose, "recurrence" | "timezone">): string {
  const r = payload.recurrence, zone = `<span class="s-mono s-meta">${e(payload.timezone)}</span>`;
  if (r.kind === "daily") return `${tr("s14.routine.every_day")} <span class="s-mono">${e(r.time)}</span> · ${zone}`;
  if (r.kind === "once") return `${tr("s14.routine.once_at")} ${whenIn(r.at, payload.timezone)} · ${zone}`;
  if (r.kind === "weekly") return `${tr(k(`s14.routine.weekly.${r.day}`))} ${tr("s14.routine.weekly_at")} <span class="s-mono">${e(r.time)}</span> · ${zone}`;
  const hours = r.everyMs / 3600000;
  return `${tr("s14.routine.every")} ${Number.isInteger(hours) ? `${hours} ${tr(hours === 1 ? "s14.routine.hour" : "s14.routine.hours")}` : `${Math.round(r.everyMs / 60000)} ${tr("s14.time.minutes")}`} · ${zone}`;
}
const list = (items: string[], empty: string) => items.length ? items.map(item => `<span class="s-mono">${e(item)}</span>`).join(" · ") : e(empty);
const scopeText = (scope: ScopeRef) => `${scope.kind}:${scope.id} r${scope.revision}`;

/** The exact capture in the same order on the review and on the routine's page, so the two can be compared line by line. */
function captureFacts(payload: RoutinePurpose, bots: Bot[], routes: Route[]): string {
  const { limits } = payload, wordsTag = tr("s14.routine.words");
  return `${untrusted(`<p>${e(text(payload.purpose))}</p><p class="s-meta">${tr("s14.work.completion_rule")}: ${e(text(payload.completionRule))}</p>`, wordsTag)}
    <dl class="s-kv"><dt>${tr("s14.routine.field.when")}</dt><dd>${recurrenceText(payload)}</dd><dt>${tr("s14.routine.field.runs")}</dt><dd>${payload.occurrenceBudget}</dd><dt>${tr("s14.routine.field.ends")}</dt><dd>${whenIn(payload.endsAt, payload.timezone)}</dd><dt>${tr("s14.routine.field.misfire")}</dt><dd>${tr("s14.routine.misfire")}</dd>
    <dt>${tr("s14.grant.bots")}</dt><dd>${bots.map(bot => `${e(botName(bot))} <span class="s-mono s-meta">r${bot.revision} · g${bot.generation}</span>`).join(" · ")}</dd><dt>${tr("s14.grant.route")}</dt><dd>${routes.map(route => routeText(route)).join(" · ")}</dd><dt>${tr("s14.grant.tools")}</dt><dd>${list(payload.tools, tr("s14.grant.no_tools"))}</dd><dt>${tr("s14.routine.field.resources")}</dt><dd>${list(payload.scopes.map(scopeText), tr("s14.grant.no_scopes"))}</dd>
    <dt>${tr("s14.grant.time")}</dt><dd>${Math.round(limits.wallMs / 60000)} ${tr("s14.time.minutes")}</dd><dt>${tr("s14.grant.reads")}</dt><dd>${limits.reads}</dd><dt>${tr("s14.grant.calls")}</dt><dd>${limits.calls}</dd><dt>${tr("s14.grant.concurrency")}</dt><dd>${limits.concurrency}</dd><dt>${tr("s14.grant.output")}</dt><dd>${size(limits.outputBytes)}</dd><dt>${tr("s14.routine.field.other")}</dt><dd>${tr("s14.routine.other")}</dd></dl>`;
}

const draftFields = (draft: S14RoutineDraft, review: S14RoutineReview) => [hidden("conversationId", review.conversationId), hidden("purpose", draft.purpose), hidden("completion", draft.completion), hidden("concurrent", draft.concurrent), hidden("minutes", draft.minutes), hidden("reads", draft.reads), hidden("schedule", draft.schedule), hidden("time", draft.time), hidden("day", draft.day), hidden("weekTime", draft.weekTime), hidden("hours", draft.hours), hidden("at", draft.at), hidden("timezone", draft.timezone), hidden("occurrences", draft.occurrences), hidden("days", draft.days), hidden("endsAt", review.payload.endsAt), ...review.payload.bots.map(ref => hidden(`bot:${e(ref.id)}`, ref.revision)), ...review.payload.tools.map(tool => hidden(`tool:${e(tool)}`, "on")), ...review.payload.scopes.map(scope => hidden(`${scope.kind === "resource" ? "account" : "scope"}:${e(scope.id)}`, scope.revision))].join("");
/** Review of one exact capture. Enable and Edit share the fields shown, so what is read is what is sent. */
function reviewPage(page: S14Page, view: S14RoutineNew, review: S14RoutineReview): string {
  const strip = ownerStrip(`<form method="post" action="/s14/forms/routine-enable" class="s-strip-form s-row">${hidden("csrf", page.csrf)}${hidden("requestId", review.requestId)}${hidden("expectedRevision", review.expectedRevision)}${draftFields(view.draft, review)}<button class="s-btn primary">${tr("s14.routine.enable")}</button><button class="s-btn" formaction="/s14/forms/routine-edit">${tr("s14.routine.edit")}</button></form>`, tr("s14.routine.enable_note"));
  return shell(page, tr("s14.routine.review_title"), `<div class="s-col"><article class="s-slip" aria-label="${tr("s14.routine.review_title")}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${tr("s14.routine.review_title")}</h2><p class="s-meta">${tr("s14.routine.review_meta")}</p></div></div><div class="s-slip-body">${captureFacts(review.payload, review.bots, review.routes)}<dl class="s-kv"><dt>${tr("s14.routine.field.first")}</dt><dd>${whenIn(review.firstRun, review.payload.timezone, review.payload.recurrence.kind === "weekly")}</dd></dl>${reach(["s14.routine.does_1", "s14.routine.does_2", "s14.routine.does_3"], ["s14.routine.not_1", "s14.routine.not_2", "s14.routine.not_3", "s14.routine.not_4"])}</div>${strip}</article></div>`, { current: "routines", subtitle: tr("s14.routine.subtitle") });
}

function scheduleField(draft: S14RoutineDraft): string {
  const option = (value: S14RoutineDraft["schedule"], label: string, control: string) => `<div class="s-sched-row"><label class="s-check"><input type="radio" name="schedule" value="${value}"${draft.schedule === value ? " checked" : ""}><span>${e(label)}</span></label>${control}</div>`;
  const hours = `<label class="s-limit"><input type="number" name="hours" min="${routineBounds.hours[0]}" max="${routineBounds.hours[1]}" value="${e(draft.hours)}" inputmode="numeric"><span>${tr("s14.routine.hours")}</span></label>`;
  // Monday first, with Sunday last, and the value stays the seam's Sunday=0.
  const days = [1, 2, 3, 4, 5, 6, 0].map(day => `<option value="${day}"${draft.day === String(day) ? " selected" : ""}>${tr(k(`s14.routine.day.${day}`))}</option>`).join("");
  const weekly = `<label class="s-sched-input"><span class="sr-only">${tr("s14.routine.weekday_label")}</span><select name="day">${days}</select></label><span class="s-sched-pair"><span class="s-sched-word">${tr("s14.routine.weekly_at")}</span><label class="s-sched-input"><span class="sr-only">${tr("s14.routine.week_time")}</span><input type="time" name="weekTime" value="${e(draft.weekTime)}"></label></span><p class="s-note s-sched-note">${tr("s14.routine.weekly_note")}</p>`;
  return `<fieldset class="s-field"><legend>${tr("s14.routine.field.when")}</legend>${option("daily", tr("s14.routine.every_day"), `<label class="s-sched-input"><span class="sr-only">${tr("s14.routine.time")}</span><input type="time" name="time" value="${e(draft.time)}"></label>`)}${option("weekly", tr("s14.routine.every_week"), weekly)}${option("interval", tr("s14.routine.every"), hours)}${option("once", tr("s14.routine.once_at"), `<label class="s-sched-input"><span class="sr-only">${tr("s14.routine.at")}</span><input type="datetime-local" name="at" value="${e(draft.at)}"></label>`)}</fieldset>`;
}
function botChoices(page: S14Page, draft: S14RoutineDraft): string {
  const bots = page.state.bots.filter(bot => bot.enabled);
  return `<fieldset class="s-field"><legend>${tr("s14.routine.field.bots")}</legend>${bots.map(bot => `<label class="s-check"><input type="checkbox" name="bot:${e(bot.id)}" value="${bot.revision}"${draft.bots.includes(bot.id) ? " checked" : ""}><span>${e(botName(bot))}</span></label>`).join("")}<p class="s-note">${tr("s14.routine.bots_note")}</p></fieldset>`;
}
function toolChoices(page: S14Page, draft: S14RoutineDraft): string {
  const bots = page.state.bots.filter(bot => bot.enabled), tools = page.policy.tools.filter(tool => generalTool(tool) && tool !== "personal_read" && bots.some(bot => bot.capabilities.tools.includes(tool)));
  if (!tools.length) return `<div class="s-field"><p class="s-sub">${tr("s14.routine.no_tools")}</p><p><a class="s-link-text" href="/team/jit/capabilities">${tr("s14.routine.add_tools")}</a></p></div>`;
  return `<fieldset class="s-field"><legend>${tr("s14.grant.tools")}</legend>${tools.map(tool => `<label class="s-check"><input type="checkbox" name="tool:${e(tool)}" value="on"${draft.tools.includes(tool) ? " checked" : ""}><span class="s-mono">${e(tool)}${tool.startsWith("effect_") ? `<small>${tr("s14.grant.effect_tool")}</small>` : ""}</span></label>`).join("")}</fieldset>`;
}
/** The whole form is visible without script. Fixed rows are text: a routine has one misfire policy, and out-of-scope findings have one outcome. */
function formPage(page: S14Page, view: S14RoutineNew): string {
  const { draft } = view, enabled = page.state.bots.filter(bot => bot.enabled), scopes = `${shareChoices(page, enabled, draft, null)}${accountChoices(page, enabled, draft, true)}`;
  const content = `<form class="s-stack" method="post" action="/s14/forms/routine-preview" novalidate>${hidden("csrf", page.csrf)}<label class="s-field"><span>${tr("s14.routine.field.what")}</span><textarea name="purpose" rows="3" maxlength="16384" required>${e(draft.purpose)}</textarea><span class="s-note">${tr("s14.routine.what_note")}</span></label>
    ${scheduleField(draft)}<label class="s-field"><span>${tr("s14.routine.field.timezone")}</span><input class="s-mono" name="timezone" value="${e(draft.timezone)}" maxlength="128" autocomplete="off" autocapitalize="off" spellcheck="false"${view.fresh ? " data-device-timezone" : ""}><span class="s-note">${tr("s14.routine.timezone_note")}</span></label>
    <div class="s-row"><label class="s-limit"><input type="number" name="occurrences" min="${routineBounds.occurrences[0]}" max="${routineBounds.occurrences[1]}" value="${e(draft.occurrences)}" inputmode="numeric"><span>${tr("s14.routine.field.runs")}</span></label><label class="s-limit"><input type="number" name="days" min="${routineBounds.days[0]}" max="${routineBounds.days[1]}" value="${e(draft.days)}" inputmode="numeric"><span>${tr("s14.routine.field.days")}</span></label></div>
    ${botChoices(page, draft)}${toolChoices(page, draft)}${scopes}${limitFields(draft, "s14.routine.limits_title")}<details class="s-more"><summary>${tr("s14.composer.more")}</summary><div><label class="s-field"><span>${tr("s14.composer.completion")}</span><input name="completion" maxlength="1000" value="${e(draft.completion)}" placeholder="${tr("s14.work.default_completion")}"></label></div></details>
    <dl class="s-kv"><dt>${tr("s14.routine.field.misfire")}</dt><dd>${tr("s14.routine.misfire")}</dd><dt>${tr("s14.routine.field.other")}</dt><dd>${tr("s14.routine.other")}</dd></dl><div><button class="s-btn primary">${tr("s14.routine.review")}</button></div></form>`;
  return shell(page, tr("s14.routine.new"), `<div class="s-col">${notice(view.notice)}<section class="s-card s-stack" aria-label="${tr("s14.routine.new")}">${content}</section><p><a class="s-link-text" href="/routines">${tr("s14.routine.back")}</a></p></div>`, { current: "routines", subtitle: tr("s14.routine.subtitle") });
}

/** The word for a run. Quiet is calm and a failure is loud, and neither can look like the other. */
function runPill(run: RoutineOccurrence): string {
  if (run.state === "running") return pill(tr("s14.work_state.running"), "strong");
  if (ownerStoppedRun(run)) return pill(tr("s14.routine.run.owner_stopped"));
  if (run.state === "stopped" || run.state === "failed" || run.outcome === "failed") return pill(tr("s14.routine.run.failed"), "danger", "×");
  if (run.outcome === "needs_owner") return pill(tr("s14.work_state.waiting"), "warn", "!");
  if (run.outcome === "no_update") return pill(tr("s14.routine.run.quiet"));
  return pill(tr("s14.routine.run.report"), "strong");
}
const failedRun = (run: RoutineOccurrence) => (run.state === "failed" || run.state === "stopped") && !ownerStoppedRun(run);
function runDelivery(item: AttentionNotice | undefined): string {
  if (item?.state === "unknown" || item?.remote === "uncertain") return `<p class="s-note">${tr("s14.routine.delivery.unknown")}</p>`;
  return item?.state === "failed" ? `<p class="s-note">${tr("s14.routine.delivery.failed")}</p>` : "";
}
function runRow(run: RoutineOccurrence, timezone: string, item: AttentionNotice | undefined): string {
  const quiet = run.outcome === "no_update" && run.state === "complete";
  const missed = run.missed ? `<p class="s-note">${e(tr("s14.routine.missed").replace("{count}", String(run.missed.count)))}</p>` : "", clock = run.resolution === "exact" ? "" : `<p class="s-note">${tr(k(`s14.routine.resolution.${run.resolution}`))}</p>`;
  const why = run.reason && !ownerStoppedRun(run) ? `<p class="s-sub">${e(reasonWord(run.reason))}</p><p class="s-mono s-meta">${e(run.reason)}</p>` : "";
  return `<li class="s-run${quiet ? " quiet" : ""}"><div class="s-run-hd">${whenIn(run.scheduledInstant, timezone)}${run.trigger ? ` · ${tr(run.trigger === "owner" ? "s14.routine.trigger.owner" : "s14.routine.trigger.schedule")}` : ""}<span class="s-grow"></span>${runPill(run)}</div>${why}${missed}${clock}${runDelivery(item)}${run.workId ? `<p><a class="s-link-text" href="/work/${e(run.workId)}">${tr("s14.routine.open_run")}</a></p>` : ""}</li>`;
}
const listedRuns = 50;
function history(view: S14RoutineDetail): string {
  const runs = view.view.history, timezone = view.view.routine.capture.command.payload.timezone;
  const count = (test: (run: RoutineOccurrence) => boolean) => runs.filter(test).length, fact = (name: string, value: number) => `<div><dt>${tr(k(`s14.routine.count.${name}`))}</dt><dd><b>${value}</b></dd></div>`;
  const body = runs.length ? `<dl class="s-facts s-recovery-counts">${fact("all", runs.length)}${fact("quiet", count(run => run.outcome === "no_update"))}${fact("failed", count(failedRun))}${fact("needs", count(run => run.outcome === "needs_owner"))}</dl><ol class="s-run-list">${runs.slice(0, listedRuns).map(run => runRow(run, timezone, view.notices[run.id])).join("")}</ol>${runs.length > listedRuns ? `<p class="s-note">${tr("s14.routine.older")}: ${runs.length - listedRuns}</p>` : ""}` : `<p class="s-sub">${tr("s14.routine.no_runs")}</p>`;
  return `<section class="s-stack" aria-labelledby="s14-routine-history"><h2 class="s-section-t" id="s14-routine-history">${tr("s14.routine.history")}</h2>${body}<p class="s-note">${tr("s14.routine.quiet_note")}</p></section>`;
}
/** A finding is a task nobody started. Its text stays framed, its strip offers only the existing accept and reject, and neither starts it. */
function findingSlip(page: S14Page, { work }: S14RoutineFinding): string {
  const body = untrusted(`<p><b>${e(text(work.title))}</b></p><p>${e(text(work.purpose))}</p><p class="s-meta">${tr("s14.task.completion")}: ${e(text(work.completionRule))}</p>`, tr("s14.routine.finding_tag"));
  if (work.state !== "proposed") return `<article class="s-slip" data-state="closed" aria-label="${tr("s14.routine.finding")}"><div class="s-slip-hd"><div><h3>${tr("s14.routine.finding")}</h3></div>${pill(tr(k(`s14.work_state.${work.state}`)))}</div><div class="s-slip-body">${body}<p><a class="s-link-text" href="/work/${e(work.id)}">${tr("s14.routine.open_finding")}</a></p></div></article>`;
  return `<article class="s-slip" aria-label="${tr("s14.routine.finding")}"><div class="s-slip-hd"><div><h3>${tr("s14.routine.finding")}</h3><p class="s-meta">${tr("s14.routine.finding_meta")}</p></div>${pill(tr("s14.work_state.proposed"), "strong")}</div><div class="s-slip-body">${body}</div>${ownerStrip(`${commandForm(page.csrf, "task.accept", work.revision, { taskId: work.id }, tr("s14.task.accept"))}${commandForm(page.csrf, "task.reject", work.revision, { taskId: work.id }, tr("s14.task.reject"))}`, tr("s14.routine.finding_note"))}</article>`;
}
function findings(page: S14Page, items: S14RoutineFinding[]): string {
  return items.length ? `<section class="s-stack" id="findings" aria-labelledby="s14-routine-findings"><h2 class="s-section-t" id="s14-routine-findings">${tr("s14.routine.findings")}</h2>${items.map(item => findingSlip(page, item)).join("")}</section>` : "";
}
function stateBanner(page: S14Page, detail: S14RoutineDetail, timezone: string): string {
  const { view } = detail, { routine, nextRun, history: runs } = view, latest = runs.find(run => run.state !== "running");
  if (routine.state === "blocked") return banner("warn", tr("s14.routine.blocked_title"), `${reasonWord(routine.reason)} ${tr("s14.routine.blocked_next")}`, routine.reason ? `<p class="s-mono s-meta">${e(routine.reason)}</p>` : "");
  if (routine.state === "paused") return banner("", tr("s14.routine.state.paused"), tr(routine.occurrencesRemaining ? "s14.routine.paused_detail" : "s14.routine.paused_empty"));
  if (routine.state === "revoked") return banner("", tr("s14.routine.state.revoked"), tr("s14.routine.revoked_detail"));
  if (routine.state === "exhausted") return banner("", tr("s14.routine.state.exhausted"), tr("s14.routine.exhausted_detail"));
  if (latest && failedRun(latest)) { const item = detail.notices[latest.id], open = item && item.resolvedAt === null; return banner("danger", tr("s14.routine.latest_failed"), reasonWord(latest.reason), open ? dismissForm(page, item, "routine", "", routine.id) : ""); }
  return nextRun ? `<p class="s-sub">${tr("s14.routine.next")} ${whenIn(nextRun, timezone, routine.capture.command.payload.recurrence.kind === "weekly")}</p>` : "";
}
/** One early run. It restates what the capture already holds and what it costs, and carries no field: the command is only this routine at this revision. */
function runNow(page: S14Page, { routine, nextRun, history: runs }: RoutineView): string {
  const payload = routine.capture.command.payload, { limits } = payload, last = routine.occurrencesRemaining === 1;
  if (routine.state !== "active" || routine.occurrencesRemaining < 1 || payload.endsAt <= page.now) return "";
  if (runs.some(run => run.state === "running")) return `<p class="s-note">${tr("s14.routine.run_now_running")}</p>`;
  const next = nextRun ? `${tr("s14.routine.run_now_next")} ${whenIn(nextRun, payload.timezone, payload.recurrence.kind === "weekly")}` : "";
  const facts = `<dl class="s-kv"><dt>${tr("s14.routine.run_now_uses")}</dt><dd>${last ? tr("s14.routine.run_now_left_last") : e(tr("s14.routine.run_now_left").replace("{left}", String(routine.occurrencesRemaining)))}</dd><dt>${tr("s14.routine.run_now_scope")}</dt><dd>${tr("s14.routine.run_now_same")}</dd><dt>${tr("s14.routine.run_now_limits")}</dt><dd>${Math.round(limits.wallMs / 60000)} ${tr("s14.time.minutes")} · ${tr("s14.grant.reads")} ${limits.reads} · ${tr("s14.grant.calls")} ${limits.calls}</dd>${next && !last ? `<dt>${tr("s14.routine.run_now_schedule")}</dt><dd>${next}</dd>` : ""}</dl>${last ? banner("warn", tr("s14.routine.run_now_last")) : ""}`;
  return `<article class="s-slip" data-state="closed" aria-labelledby="s14-run-now"><div class="s-slip-hd"><div><h2 id="s14-run-now">${tr("s14.routine.run_now")}</h2><p class="s-meta">${tr("s14.routine.run_now_meta")}</p></div></div><div class="s-slip-body">${facts}</div>${ownerStrip(commandForm(page.csrf, "routine.run-now", routine.revision, { routineId: routine.id }, tr("s14.routine.run_now")), tr("s14.routine.run_now_note"))}</article>`;
}
/** Controls follow what the service accepts, and the labels are fixed: a title never sits on a button. */
function controls(page: S14Page, { routine }: RoutineView): string {
  const control = (kind: "routine.pause" | "routine.resume" | "routine.revoke", label: string, cls = "s-btn") => commandForm(page.csrf, kind, routine.revision, { routineId: routine.id }, label, cls);
  const again = `<a class="s-btn" href="/routines/new?from=${e(routine.id)}">${tr("s14.routine.again")}</a>`;
  if (routine.state === "revoked") return `<p class="s-row">${again}<a class="s-btn danger" href="/routines/${e(routine.id)}?confirm=delete#slip">${tr("s14.routine.delete")}</a></p>`;
  const main = routine.state === "active" ? control("routine.pause", tr("s14.routine.pause")) : routine.state === "paused" && routine.occurrencesRemaining ? control("routine.resume", tr("s14.routine.resume"), "s-btn primary") : "";
  const note = routine.state === "paused" ? "s14.routine.resume_note" : routine.state === "blocked" ? "s14.routine.again_note" : "s14.routine.control_note";
  return `<div class="s-slip" data-state="closed">${ownerStrip(`${main}${routine.state === "blocked" || routine.state === "exhausted" ? again : ""}${control("routine.revoke", tr("s14.routine.revoke"), "s-btn danger")}`, tr(note))}</div>`;
}
/** Deleting a revoked routine has its own slip, reached by a link, so a stray press on the page cannot be the delete. Open decisions must be answered first, because their rows live on this routine. */
function deleteSlip(page: S14Page, view: S14RoutineDetail): string {
  const { routine } = view.view, back = `<a class="s-btn" href="/routines/${e(routine.id)}">${tr("s14.routine.delete_keep")}</a>`, title = tr("s14.routine.delete");
  const body = view.decisions ? banner("warn", tr("s14.routine.delete_hold"), tr("s14.routine.delete_hold_detail")) : `${reach(["s14.routine.delete_does_1", "s14.routine.delete_does_2"], ["s14.routine.delete_not_1", "s14.routine.delete_not_2", "s14.routine.delete_not_3"])}<p class="s-note">${tr("s14.routine.delete_free")}</p>`;
  const strip = view.decisions ? `<div class="s-strip">${back}</div>` : ownerStrip(`${commandForm(page.csrf, "routine.delete", routine.revision, { routineId: routine.id }, title, "s-btn danger")}${back}`, tr("s14.routine.delete_note"));
  return `<article class="s-slip" data-state="unknown" aria-label="${title}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${title}</h2><p class="s-meta">${tr("s14.routine.delete_meta")}</p></div></div><div class="s-slip-body">${body}</div>${strip}</article>`;
}
function landing(view: S14RoutineDetail): string {
  return view.receipt ? banner("", tr(k(`s14.routine.done.${view.receipt.kind.slice("routine.".length)}`)), tr(k(`s14.routine.done.${view.receipt.kind.slice("routine.".length)}_detail`))) : "";
}
function detailPage(page: S14Page, view: S14RoutineDetail): string {
  const { routine } = view.view, capture = routine.capture, payload = capture.command.payload, live = view.view.history.some(run => run.state === "running");
  const summary = `<article class="s-slip" data-state="closed" aria-label="${tr("s14.routine.capture_title")}"><div class="s-slip-hd"><div><h2>${tr("s14.routine.capture_title")} r${routine.revision}</h2><p class="s-meta">${tr("s14.routine.capture_meta")}</p></div>${statePill(routine.state)}</div><div class="s-slip-body">${captureFacts(payload, capture.bots, capture.routes)}<dl class="s-kv"><dt>${tr("s14.routine.field.left")}</dt><dd>${routine.occurrencesRemaining} / ${payload.occurrenceBudget}</dd><dt>${tr("s14.routine.field.created")}</dt><dd>${when(routine.createdAt)}</dd><dt>${tr("s14.grant.revision")}</dt><dd class="s-mono">r${routine.revision} · g${routine.generation}</dd></dl></div></article>`;
  return shell(page, tr("s14.routine.detail_title"), `<div class="s-col">${landing(view)}<div class="s-stack" id="s14-live"><span hidden data-phase="${e(`${tr("s14.routine.detail_title")} · ${tr(k(`s14.routine.state.${routine.state}`))}`)}"></span>${stateBanner(page, view, payload.timezone)}${view.confirm ? deleteSlip(page, view) : ""}${findings(page, view.findings)}${summary}${runNow(page, view.view)}${history(view)}</div>${view.confirm ? "" : controls(page, view.view)}<p><a class="s-link-text" href="/routines">${tr("s14.routine.back")}</a></p></div>`, { current: "routines", subtitle: tr("s14.routine.subtitle"), live });
}
function routineRow({ routine, nextRun, history: runs }: RoutineView): string {
  const payload = routine.capture.command.payload, latest = runs.find(run => run.state !== "running"), failing = latest && failedRun(latest) && routine.state !== "revoked";
  const line = routine.state === "active" && nextRun ? `${tr("s14.routine.next")} ${whenIn(nextRun, payload.timezone, payload.recurrence.kind === "weekly")}` : recurrenceText(payload);
  return `<a class="s-work-row" href="/routines/${e(routine.id)}"><span><span>${e(text(payload.title))}</span><small>${line}</small><small>${routine.occurrencesRemaining} / ${payload.occurrenceBudget} ${tr("s14.routine.runs_left")}</small></span><span class="s-row-pills">${failing ? pill(tr("s14.routine.run.failed"), "danger", "×") : ""}${statePill(routine.state)}</span></a>`;
}
function listPage(page: S14Page, view: S14RoutineList): string {
  const add = `<a class="s-btn primary" href="/routines/new">${icon("plus")}<span class="s-label">${tr("s14.routine.new")}</span></a>`;
  const open = view.items.filter(item => item.routine.state !== "revoked"), ended = view.items.filter(item => item.routine.state === "revoked");
  const rows = open.length ? `<section class="s-stack" aria-labelledby="s14-routine-list"><h2 class="s-section-t" id="s14-routine-list">${tr("s14.routine.list")}</h2><div class="s-stack">${open.map(routineRow).join("")}</div></section>` : `<p class="s-sub">${tr("s14.routine.empty")}</p>`;
  const closed = ended.length ? `<details class="s-card s-more"><summary>${tr("s14.routine.revoked_list")}: ${ended.length}</summary><div>${ended.map(routineRow).join("")}</div></details>` : "";
  const deleted = view.receipt ? banner("", tr("s14.routine.done.delete"), tr("s14.routine.done.delete_detail")) : "", level = `<p class="s-note">${tr(k(`s14.attention.level.now.${view.level}`))} <a class="s-link-text" href="/more#s14-attention-level">${tr("s14.attention.level.change")}</a></p>`;
  return shell(page, tr("s14.nav.routines"), `<div class="s-col">${deleted}<div class="s-between"><p class="s-sub">${tr("s14.routine.lead")}</p>${add}</div>${findings(page, view.findings)}${rows}${closed}${level}</div>`, { current: "routines", subtitle: tr("s14.routine.subtitle") });
}
/** Renders the routine surfaces. Every title, purpose and finding is escaped and framed, and none of them reaches a button. */
export function renderRoutineSurface(page: S14Page, view: S14RoutineSurface): string {
  if (view.kind === "routines") return listPage(page, view);
  if (view.kind === "routine") return detailPage(page, view);
  return view.review ? reviewPage(page, view, view.review) : formPage(page, view);
}
/** Tells apart a finding from an ordinary task where a slip shows it, so the owner sees why it grants nothing. */
export const routineFindingNote = (reason: string | null) => reason === "routine_out_of_scope" ? `<p class="s-note">${tr("s14.routine.finding_note")}</p>` : "";
