import { tr, trMaybe } from "../i18n";
import type { Attempt, Work, WorkView } from "./authority-types";
import type { WorkStep } from "./graph-types";
import type { Bot } from "./types";
import type { S14Page } from "./web";
import { banner, botName, commandForm, computerPath, e, k, notice, ownerStrip, pill, shell, size, tile, flat } from "./web-pages";
import type { S14WorkResearch } from "./web-product-memory";
import { defaultWorkLimits, workLimitBounds } from "./web-product";
import { limitValues, type S14LimitValues, type S14WorkSettings, type S14WorkTeam } from "./web-product-team";

/* Team work (TEAM14-01, F3, F4). Every interval is a recorded observation: a lane with no recorded start has no bar. */
const stepTone: Record<WorkStep["state"], [string, string]> = { queued: ["", ""], waiting_evidence: ["", ""], running: ["strong", ""], stopping: ["", ""], committed: ["ok", "✓"], failed: ["danger", "×"], cancelled: ["", ""], blocked: ["warn", "!"] };
const stepDot: Record<WorkStep["state"], string> = { queued: "hollow", waiting_evidence: "hollow", running: "working", stopping: "hollow", committed: "ready", failed: "failed", cancelled: "", blocked: "waiting" };
const stepWord = (step: WorkStep) => tr(k(`s14.step_state.${step.state}`));
const stepPill = (step: WorkStep) => pill(stepWord(step), ...stepTone[step.state]);
const settled = (step: WorkStep) => ["committed", "failed", "cancelled", "blocked"].includes(step.state);
/** Exact second in UTC; the timeline compares seconds, which the page's minute format would hide. */
const clock = (value: number) => { const iso = new Date(value).toISOString(); return `<time datetime="${iso}">${iso.slice(11, 19)} UTC</time>`; };
/** Elapsed time in words. Under a second says so rather than rounding to zero. */
export function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000); if (seconds < 1) return tr("s14.time.under_second");
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60;
  return [hours ? `${hours} ${tr("s14.time.hr")}` : "", minutes ? `${minutes} ${tr("s14.time.min")}` : "", rest && !hours ? `${rest} ${tr("s14.time.sec")}` : ""].filter(Boolean).join(" ");
}
const count = (steps: WorkStep[], state: WorkStep["state"]) => steps.filter(step => step.state === state).length;
const botOf = (page: S14Page, id: string): Pick<Bot, "id" | "name"> => page.state.bots.find(bot => bot.id === id) ?? { id, name: id };
const laneName = (page: S14Page, step: WorkStep, steps: WorkStep[]) => { const name = botName(botOf(page, step.botId)); return steps.filter(item => item.botId === step.botId).length > 1 ? `${name} · ${tr(k(`s14.step_handler.${step.handler}`))}` : name; };

/** Headline: the limit always sits next to the count, so a queue never reads as a fault. */
function headline(steps: WorkStep[], concurrency: number): string {
  const working = count(steps, "running"), lead = working > 1 ? `${working} ${tr("s14.team.working_many")}` : working === 1 ? tr("s14.team.working_one") : tr("s14.team.working_none");
  const part = (state: WorkStep["state"], key: string) => { const n = count(steps, state); return n ? `${n} ${tr(k(key))}` : ""; };
  return [lead, `${tr("s14.team.limit")} ${concurrency}`, part("stopping", "s14.team.count_stopping"), part("queued", "s14.team.count_queued"), part("waiting_evidence", "s14.team.count_waiting")].filter(Boolean).join(" · ");
}
/** Time at least two recorded intervals ran together. Derived from observations only, never from a plan. */
function overlap(intervals: [number, number][]): number {
  const edges = intervals.flatMap(([from, to]) => [[from, 1], [to, -1]] as const).toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0, last = 0, total = 0;
  for (const [at, change] of edges) { if (depth >= 2) total += at - last; depth += change; last = at; }
  return total;
}
const trackWidth = 1000, minimumBar = 6;
/** One SVG per lane: geometry attributes keep the bars server-rendered under a CSP with no inline style. */
function track(step: WorkStep, from: number, span: number, now: number): string {
  const x = (at: number) => Math.round(((at - from) / span) * trackWidth * 10) / 10, parts = ['<line class="s-tl-base" x1="0" x2="1000" y1="6" y2="6"/>'];
  if (step.startedAt !== null) {
    const left = Math.min(x(step.startedAt), trackWidth - minimumBar), right = x(step.settledAt ?? now), width = Math.max(right - left, minimumBar), end = left + width;
    if (step.state === "stopping") parts.push(`<line class="s-bar-stopping" x1="${left}" x2="${end}" y1="6" y2="6"/>`);
    else parts.push(`<rect class="s-bar-${step.state === "running" ? "run" : step.state === "cancelled" ? "stopped" : "done"}" x="${left}" y="1" width="${width}" height="10"/>`);
    if (step.state === "failed" || step.state === "blocked") parts.push(`<line class="s-bar-mark" x1="${end}" x2="${end}" y1="0" y2="12"/>`);
  }
  if (step.settledAt === null) parts.push(`<line class="s-tl-now" x1="1000" x2="1000" y1="0" y2="12"/>`);
  return `<svg class="s-tl-track" viewBox="0 0 1000 12" preserveAspectRatio="none" focusable="false">${parts.join("")}</svg>`;
}
function legend(): string {
  const item = (cls: string, key: string) => `<span><i class="s-key ${cls}"></i>${tr(k(key))}</span>`;
  return `<p class="s-tl-legend">${item("run", "s14.timeline.key_running")}${item("done", "s14.timeline.key_committed")}${item("stopping", "s14.timeline.key_stopping")}${item("stopped", "s14.timeline.key_stopped")}${item("failed", "s14.timeline.key_failed")}</p>`;
}
function stepTable(page: S14Page, steps: WorkStep[], now: number): string {
  const row = (step: WorkStep) => `<tr><th scope="row">${e(laneName(page, step, steps))}</th><td>${e(stepWord(step))}</td><td>${step.startedAt === null ? tr("s14.timeline.not_recorded") : clock(step.startedAt)}</td><td>${step.settledAt !== null ? clock(step.settledAt) : step.startedAt === null ? tr("s14.timeline.not_recorded") : tr("s14.timeline.not_settled")}</td><td>${step.startedAt === null ? tr("s14.timeline.not_recorded") : `${step.settledAt === null ? `${tr("s14.timeline.so_far")} ` : ""}${duration((step.settledAt ?? now) - step.startedAt)}`}</td></tr>`;
  return `<details class="s-more"><summary>${tr("s14.timeline.table")}</summary><div><div class="s-table" tabindex="0" role="group" aria-label="${tr("s14.timeline.table")}"><table><thead><tr><th scope="col">${tr("s14.timeline.col_step")}</th><th scope="col">${tr("s14.timeline.col_state")}</th><th scope="col">${tr("s14.timeline.col_started")}</th><th scope="col">${tr("s14.timeline.col_ended")}</th><th scope="col">${tr("s14.timeline.col_ran")}</th></tr></thead><tbody>${steps.map(row).join("")}</tbody></table></div></div></details>`;
}
/** The graphic is hidden from assistive technology; the lanes and the table carry the same observations in words. */
function timeline(page: S14Page, steps: WorkStep[]): string {
  const observed = steps.filter(step => step.startedAt !== null), now = page.now, table = stepTable(page, steps, now);
  if (!observed.length) return `<section class="s-stack" aria-labelledby="s14-timeline"><h3 class="s-section-t" id="s14-timeline">${tr("s14.timeline.title")}</h3><p class="s-sub">${tr("s14.timeline.none")}</p>${table}</section>`;
  const open = observed.some(step => step.settledAt === null), from = Math.min(...observed.map(step => step.startedAt!)), to = Math.max(from, ...(open ? [now] : []), ...observed.flatMap(step => step.settledAt === null ? [] : [step.settledAt])), span = Math.max(to - from, 1);
  const rows = steps.map(step => { const pending = step.startedAt === null || step.state === "failed" || step.state === "blocked"; return `<span class="s-tl-name">${e(laneName(page, step, steps))}${pending ? `<small class="${step.state === "failed" ? "danger" : ""}">${e(stepWord(step))}</small>` : ""}</span>${track(step, from, span, now)}`; }).join("");
  const together = observed.length > 1 ? overlap(observed.map(step => [step.startedAt!, step.settledAt ?? now])) : null;
  const word = together === null ? "" : `<p class="s-note">${together ? `${tr("s14.timeline.overlap")} ${e(duration(together))}` : tr("s14.timeline.no_overlap")}</p>`;
  return `<section class="s-stack" aria-labelledby="s14-timeline"><h3 class="s-section-t" id="s14-timeline">${tr("s14.timeline.title")}</h3><div class="s-tl" aria-hidden="true">${rows}<span></span><span class="s-tl-axis"><span>${clock(from)}</span><span>${e(duration(to - from))}</span></span></div>${legend()}${word}<p class="s-note">${tr("s14.timeline.note")}</p>${table}</section>`;
}

const hiddenSubjects = new Set(["[refused input]", "[outbound blocked]", "[withdrawn context]"]);
/** Reads of this lane's own attempt: the exact current subject, plus the count that really left the machine. */
function laneReads(step: WorkStep, research: S14WorkResearch | null): string {
  const reads = (research?.reads ?? []).filter(read => read.attemptId === step.attemptId), running = reads.findLast(read => read.outcome === "running" && !hiddenSubjects.has(read.subject));
  const done = reads.filter(read => read.dispatched && read.outcome !== "running").length;
  return `${running ? `<p class="s-exact-label">${tr("s14.team.reading")}</p><p class="s-mono">${e(running.subject)}</p>` : ""}${step.attemptId ? `<p class="s-meta">${tr("s14.team.reads_done")} ${done}</p>` : ""}`;
}
/** Labels of what this run received; never the text itself, which stays on Evidence and the result. */
function handoff(page: S14Page, step: WorkStep, steps: WorkStep[], attempt: Attempt | undefined, research: S14WorkResearch | null): string {
  if (!attempt) return "";
  const context = attempt.memoryId ? research?.contexts.find(item => item.id === attempt.memoryId) : undefined, claims = context ? context.claims.length + context.decisions.length : 0;
  const labelOf = (id: string) => { const lane = steps.find(item => item.id === id); return lane ? laneName(page, lane, steps) : tr("s14.team.unknown_step"); };
  const parts = [tr("s14.team.received_command"), ...(claims ? [`${tr("s14.team.received_memory")} ${claims}`] : []), ...(attempt.step?.inputs ?? []).map(input => `${tr("s14.team.received_from")} ${labelOf(input.stepId)}`)];
  const gaps = (attempt.step?.gaps ?? []).map(gap => `<p class="s-meta">${tr("s14.team.gap")} ${e(labelOf(gap.stepId))} · ${e(trMaybe(`s14.reason.${gap.reason}`) ?? tr("s14.reason.generic"))} <span class="s-mono">${e(gap.reason)}</span></p>`).join("");
  return `<p class="s-meta">${tr("s14.team.received")} ${parts.map(e).join(" · ")}</p>${gaps}`;
}
/** Plain line per state. Waiting names the exact lanes it depends on, because the fix differs from a queue. */
function laneLine(page: S14Page, step: WorkStep, steps: WorkStep[], depends: string[]): string {
  const code = step.reason && !["dependency_uncommitted", "owner_stopped_step", "work_stopped"].includes(step.reason) ? step.reason : null, why = code ? trMaybe(`s14.reason.${code}`) ?? tr("s14.reason.generic") : "";
  if (step.state === "waiting_evidence") {
    const waiting = depends.flatMap(id => { const lane = steps.find(item => item.nodeId === id); return lane && lane.state !== "committed" ? [laneName(page, lane, steps)] : []; });
    return `<p class="s-sub">${tr("s14.team.waiting_on")} ${e(waiting.join(" · ") || tr("s14.team.unknown_step"))}</p>`;
  }
  if (step.state === "running" && step.startedAt !== null) return `<p class="s-sub">${tr("s14.team.running_since")} ${clock(step.startedAt)}</p>`;
  const ceiling = step.state === "queued" && step.queueCeiling ? tr(k(step.queueCeiling === "work" ? "s14.team.limit" : `s14.defaults.ceiling_${step.queueCeiling}`)) : "";
  const line = tr(k(`s14.step_line.${step.state}`)), detail = [why, ceiling].filter(Boolean).join(" · ");
  return `<p class="s-sub">${e(`${detail ? `${detail}. ` : ""}${line}`)}</p>${code ? `<p class="s-mono s-meta">${e(code)}</p>` : ""}`;
}
/** One lane per graph step. Stopping one is only offered when a sibling exists; a lone lane is the whole work. */
function lane(page: S14Page, view: WorkView, team: S14WorkTeam, step: WorkStep, research: S14WorkResearch | null): string {
  const graph = team.graph!, steps = graph.steps, node = graph.graph.nodes.find(item => item.id === step.nodeId), bot = botOf(page, step.botId), attempt = view.attempts.find(item => item.id === step.attemptId);
  const name = laneName(page, step, steps), computer = node?.tools.includes("computer") ? `<p><a class="s-link-text" href="${computerPath(bot)}">${tr("s14.work.view_computer")}</a></p>` : "";
  const stop = steps.length > 1 && !settled(step) && step.state !== "stopping" ? ownerStrip(commandForm(page.csrf, "work.step.stop", step.revision, { workId: step.workId, stepId: step.id }, tr("s14.team.stop_step"), "s-btn danger"), tr("s14.team.stop_step_note")) : "";
  return `<article class="s-slip" data-state="closed" aria-label="${e(name)}"><div class="s-lane-row">${tile(bot, stepDot[step.state], "")}<div class="s-stack"><div class="s-between"><b>${e(botName(bot))}</b>${stepPill(step)}</div><p class="s-meta">${tr(k(`s14.step_handler.${step.handler}`))}</p>${laneLine(page, step, steps, node?.dependsOn ?? [])}${laneReads(step, research)}${handoff(page, step, steps, attempt, research)}${computer}</div></div>${stop}</article>`;
}
/** A failed sibling is named next to what was kept, so the owner never reads it as lost work. */
function siblingBanner(page: S14Page, view: WorkView, steps: WorkStep[]): string {
  if (view.work.state === "stopped" || view.work.state === "stopping") return "";
  const broken = steps.filter(step => step.state === "failed" || step.state === "blocked" || step.state === "cancelled"), kept = steps.filter(step => step.state === "committed");
  if (!broken.length || steps.length < 2) return "";
  const names = (items: WorkStep[]) => items.map(step => laneName(page, step, steps)).join(" · ");
  return banner("warn", tr(kept.length ? "s14.team.sibling_title" : "s14.team.sibling_none_title"), `${tr("s14.team.sibling_broken")} ${names(broken)}. ${kept.length ? `${tr("s14.team.sibling_kept")} ${names(kept)}. ` : ""}${tr("s14.team.sibling_note")}`);
}
/** Progress sections for a work graph: headline, sibling banner, recorded timeline and lanes. */
export function teamProgress(page: S14Page, view: WorkView, team: S14WorkTeam, research: S14WorkResearch | null): string {
  const graph = team.graph; if (!graph) return "";
  return `<p class="s-headline">${e(headline(graph.steps, graph.concurrency))}</p>${siblingBanner(page, view, graph.steps)}${timeline(page, graph.steps)}<section class="s-stack" aria-labelledby="s14-lanes"><h3 class="s-section-t" id="s14-lanes">${tr("s14.work.lanes")}</h3>${graph.steps.map(step => lane(page, view, team, step, research)).join("")}</section>`;
}

/** Meter with its words. Near the ceiling is a word too, so it never depends on the bar. */
function meter(label: string, used: number, limit: number, text: string): string {
  const near = limit > 0 && used / limit >= 0.8 ? ` · ${tr("s14.usage.near")}` : "";
  return `<div class="s-meter"><span>${e(label)}</span><small>${e(text)}${near}</small><meter min="0" max="${limit}" value="${Math.min(used, limit)}" aria-label="${e(label)}">${e(text)}</meter></div>`;
}
/** Grant limits against reservations and elapsed time. Actual use stays unknown, hatched and never zero. */
export function usageBlock(page: S14Page, view: WorkView, team: S14WorkTeam | null): string {
  const { grant, reservations } = view; if (!grant || !reservations) return "";
  const reserved = (label: string, used: number, limit: number, format: (n: number) => string = String) => meter(label, used, limit, `${tr("s14.usage.reserved")} ${format(used)} ${tr("s14.usage.of")} ${format(limit)}`);
  const steps = team?.graph?.steps ?? [], ended = steps.length && steps.every(settled) ? Math.max(...steps.map(step => step.settledAt ?? 0)) : 0;
  const last = ["ready", "stopped", "blocked"].includes(view.work.state) && ended ? ended : page.now, elapsed = Math.min(Math.max(last - grant.createdAt, 0), grant.limits.wallMs);
  const clockText = `${e(duration(elapsed))} ${tr("s14.usage.of")} ${e(duration(grant.limits.wallMs))}`;
  return `<section class="s-stack" aria-labelledby="s14-usage"><h3 class="s-section-t" id="s14-usage">${tr("s14.usage.title")}</h3>${meter(tr("s14.usage.time"), elapsed, grant.limits.wallMs, clockText)}${reserved(tr("s14.usage.reads"), reservations.reads, grant.limits.reads)}${reserved(tr("s14.usage.calls"), reservations.calls, grant.limits.calls)}${reserved(tr("s14.usage.output"), reservations.outputBytes, grant.limits.outputBytes, size)}
    <div class="s-meter"><span>${tr("s14.usage.actual")}</span><small>${tr("s14.unknown")}</small><span class="s-unknown-bar" aria-hidden="true"></span></div><p class="s-note">${tr("s14.usage.note")}</p></section>`;
}
/** Up to six mini lanes for a work card, so overlap is visible from the conversation. */
export function miniLanes(page: S14Page, work: Work): string {
  const steps = page.overview.lanes[work.id] ?? []; if (!steps.length) return "";
  const shown = steps.slice(0, 6), rest = steps.length - shown.length;
  return `${shown.map(step => `<div class="s-lane-mini">${tile(botOf(page, step.botId), stepDot[step.state], "small")}<span class="s-grow">${e(laneName(page, step, steps))}</span><span>${e(stepWord(step))}</span></div>`).join("")}${rest ? `<p class="s-note s-lane-more">${tr("s14.team.more_lanes")} ${rest}</p>` : ""}`;
}

/** Future-work defaults. A change here never reaches a grant that already exists. */
export function workSettingsPage(page: S14Page, view: S14WorkSettings): string {
  const values: S14LimitValues = view.draft ?? limitValues(view.defaults), { limits } = view;
  const field = (name: keyof S14LimitValues, key: string, hint: string) => `<div class="s-field"><label for="s14-default-${name}">${tr(k(key))}</label><input id="s14-default-${name}" type="number" name="${name}" required min="${workLimitBounds[name][0]}" max="${workLimitBounds[name][1]}" value="${values[name]}" inputmode="numeric"><p class="s-note">${tr(k(hint))}</p></div>`;
  const factory = `${tr("s14.defaults.factory")} ${defaultWorkLimits.concurrent} · ${defaultWorkLimits.minutes} · ${defaultWorkLimits.reads}`;
  const form = `<form class="s-stack" method="post" action="/s14/forms/work-defaults">${flat(page.csrf, view.defaults.revision)}${field("concurrent", "s14.defaults.concurrent", "s14.defaults.concurrent_note")}${field("minutes", "s14.defaults.minutes", "s14.defaults.minutes_note")}${field("reads", "s14.defaults.reads", "s14.defaults.reads_note")}<p class="s-note">${e(factory)}</p><div><button class="s-btn primary">${tr("s14.defaults.save")}</button></div></form>`;
  const ceilings = `<section class="s-card s-stack" aria-labelledby="s14-ceilings"><h2 id="s14-ceilings">${tr("s14.defaults.ceilings")}</h2><dl class="s-kv"><dt>${tr("s14.defaults.ceiling_global")}</dt><dd>${limits.global}</dd><dt>${tr("s14.defaults.ceiling_route")}</dt><dd>${limits.route}</dd><dt>${tr("s14.defaults.ceiling_bot")}</dt><dd>${limits.bot}</dd><dt>${tr("s14.defaults.ceiling_computer")}</dt><dd>${limits.computer}</dd></dl><p class="s-note">${tr("s14.defaults.ceilings_note")}</p></section>`;
  const saved = view.saved ? banner("ok", tr("s14.defaults.saved"), tr("s14.defaults.saved_detail")) : "";
  return shell(page, tr("s14.defaults.title"), `<div class="s-col">${saved}${notice(view.notice)}<section class="s-card s-stack" aria-labelledby="s14-defaults"><div class="s-between"><h2 id="s14-defaults">${tr("s14.defaults.heading")}</h2><span class="s-mono s-meta">r${view.defaults.revision}</span></div><p class="s-sub">${tr("s14.defaults.lead")}</p>${form}</section>${ceilings}<p><a class="s-link-text" href="/more">${tr("s14.web.back")}</a></p></div>`, { current: "more", subtitle: tr("s14.defaults.subtitle") });
}
