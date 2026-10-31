import { tr } from "../i18n";
import type { WorkView } from "./authority-types";
import type { ExternalEvidence } from "./parallel-types";
import type { S14Page } from "./web";
import { banner, botName, commandForm, e, k, ownerStrip, remaining } from "./web-pages";
import type { S14WorkResearch } from "./web-product-memory";

type Blocker = "effect" | "stated" | "open_call" | "revoked" | "expired" | "bot" | "budget";
const recoverable = ["blocked", "waiting", "ready"];
/** Why neither recovery command could be admitted right now. Advisory wording only: the service rechecks every condition. */
function blockerOf(page: S14Page, view: WorkView): Blocker | null {
  const { grant, authority, reservations } = view; if (!grant) return null;
  const open = view.effects.filter(effect => ["pending", "approved", "executing", "unknown"].includes(effect.state));
  // An owner statement is not a verified outcome, so the service keeps refusing; only the honest next step differs.
  if (open.length) return open.every(effect => effect.resolution) ? "stated" : "effect";
  if (view.attempts.some(attempt => ["running", "interrupted"].includes(attempt.state))) return "open_call";
  if (authority?.revoked) return "revoked";
  if (page.now >= grant.expiresAt) return "expired";
  if (grant.bots.some(bot => { const current = page.state.bots.find(item => item.id === bot.id); return !current || !current.enabled || current.revision !== bot.revision; })) return "bot";
  if (reservations && (reservations.attempts >= grant.limits.attempts || reservations.steps >= grant.limits.steps || reservations.calls >= grant.limits.calls || reservations.outputBytes >= grant.limits.outputBytes)) return "budget";
  return null;
}
const coverageWords = (items: ExternalEvidence[]) => (["full_content_returned", "excerpt", "snippet"] as const).flatMap(kind => { const count = items.filter(item => item.coverage === kind).length; return count ? [`${tr(k(`s14.coverage.${kind}`))} ${count}`] : []; }).join(" · ");
/** What exists, in words and counts, so a summary cannot be read as covering more than the retained sources. */
function evidenceRows(page: S14Page, view: WorkView, research: S14WorkResearch | null): string {
  const first = view.grant!.bots[0]!, evidence = research?.evidence ?? [], own = evidence.filter(item => item.botId === first.id), others = evidence.length - own.length;
  const failed = (research?.reads ?? []).filter(read => read.outcome !== "success" && read.outcome !== "running").length, { limits } = view.grant!, used = view.reservations;
  const left = used ? `${Math.max(0, limits.attempts - used.attempts)} ${tr("s14.recover.attempts")} · ${Math.max(0, limits.calls - used.calls)} ${tr("s14.recover.reads")} · ${remaining(view.grant!.expiresAt, page.now)}` : tr("s14.unknown");
  return `<dl class="s-kv s-recovery-rows"><dt>${tr("s14.recover.evidence")}</dt><dd>${own.length ? `${own.length} ${tr("s14.recover.evidence_of")} ${e(botName(page.state.bots.find(bot => bot.id === first.id) ?? first))}<br><span class="s-note">${e(coverageWords(own))}</span>` : tr("s14.recover.evidence_none")}</dd>${others ? `<dt>${tr("s14.recover.other_bots")}</dt><dd>${others} ${tr("s14.recover.other_bots_detail")}</dd>` : ""}${failed ? `<dt>${tr("s14.recover.failed")}</dt><dd>${failed} ${tr("s14.recover.failed_detail")}</dd>` : ""}<dt>${tr("s14.recover.left")}</dt><dd>${left}</dd></dl>`;
}
/** F14 owner choices. Nothing here runs by itself, and no copy implies a fallback, a refund or a changed route. */
export function recoveryPanel(page: S14Page, view: WorkView, research: S14WorkResearch | null): string {
  const { work, grant } = view; if (!grant || !recoverable.includes(work.state)) return "";
  // Coding never replays: the service refuses both commands, and "Start as new work" here would start uncoded work. The Coding tab offers the real way.
  if (grant.tools.includes("coding")) return "";
  const blocker = blockerOf(page, view), redo = `/chats/${e(work.conversationId)}?redo=${e(work.id)}#s14-text`, rows = evidenceRows(page, view, research);
  const hasEvidence = (research?.evidence ?? []).some(item => item.botId === grant.bots[0]!.id);
  const fresh = `<p><a class="s-link-text" href="${redo}">${tr("s14.recover.start_new")}</a></p><p class="s-note">${tr("s14.recover.start_new_note")}</p>`;
  const open = view.effects.find(effect => ["pending", "approved", "executing", "unknown"].includes(effect.state));
  const inner = blocker
    ? `<div class="s-slip-body s-slip-top">${banner("warn", tr(k(`s14.recover.block.${blocker}_title`)), tr(k(`s14.recover.block.${blocker}_detail`)), blocker === "effect" && open ? `<p><a class="s-link-text" href="/effects/${e(open.id)}#slip">${tr("s14.recover.block.effect_open")}</a></p>` : "")}${rows}${blocker === "effect" || blocker === "open_call" ? "" : fresh}</div>`
    : `<div class="s-slip-body s-slip-top">${rows}${hasEvidence ? "" : `<p class="s-sub">${tr("s14.recover.no_summary")}</p>`}</div>${ownerStrip(`${commandForm(page.csrf, "work.retry", work.revision, { workId: work.id }, tr("s14.recover.retry"), work.state === "ready" ? "s-btn" : "s-btn primary")}${hasEvidence ? commandForm(page.csrf, "work.summarize", work.revision, { workId: work.id }, tr("s14.recover.summarize")) : ""}`, tr("s14.recover.note"), "", hasEvidence ? `<p class="s-note">${tr("s14.recover.summary_note")}</p>` : "")}`;
  const card = `<article class="s-slip" data-state="closed" aria-labelledby="s14-recover"><div class="s-slip-hd"><div><h3 id="s14-recover">${tr("s14.recover.title")}</h3><p class="s-meta">${tr("s14.recover.lead")}</p></div></div>${inner}</article>`;
  return work.state === "ready" ? `<details class="s-more"><summary>${tr("s14.recover.more")}</summary><div>${card}</div></details>` : card;
}
/** Says how the current result came about, so a summary never reads as a complete report. */
export function recoveryNotice(view: WorkView): string {
  const recovery = view.work.recovery; if (!recovery) return "";
  return recovery.mode === "summarize" ? banner("", tr("s14.recover.done_summarize"), tr("s14.recover.done_summarize_detail").replace("{count}", String(recovery.sources.length))) : banner("", tr("s14.recover.done_retry"), tr("s14.recover.done_retry_detail"));
}
