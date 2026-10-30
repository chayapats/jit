import { tr, trMaybe } from "../i18n";
import { banner, botName, e, effectPill, k, pill, shell, when } from "./web-pages";
import type { S14Page } from "./web";
import type { S14RecoveryGroup, S14RecoveryItem, S14RecoverySession, S14RecoveryStep, S14RecoverySurface } from "./web-product-recovery";

/* After a restart (REC14-01, F14). The page reads metadata only. It says what Jit knows, says plainly what it cannot confirm, and never words a session as stopped or deleted unless the service recorded that. */
const phaseTone: Record<S14RecoveryItem["phase"], [string, string]> = { queued: ["", ""], resumed: ["strong", ""], waiting: ["warn", "!"], unconfirmed: ["warn", "?"], closed: ["", ""] };
const phasePill = (item: S14RecoveryItem) => item.effect ? effectPill(item.effect.state) : pill(tr(k(`s14.recovery.phase.${item.phase}`)), ...phaseTone[item.phase]);
const stepName = (page: S14Page, step: S14RecoveryStep) => { const bot = page.state.bots.find(item => item.id === step.botId) ?? { id: step.botId, name: step.botName }; return `${botName(bot)}${step.handler ? ` · ${tr(k(`s14.step_handler.${step.handler}`))}` : ""}`; };
const workHref = (item: S14RecoveryItem) => `/work/${e(item.work.id)}`;
const redoHref = (item: S14RecoveryItem) => `/chats/${e(item.work.conversationId)}?redo=${e(item.work.id)}#s14-text`;

function headline(item: S14RecoveryItem): string {
  if (item.effect) return tr("s14.recovery.effect_title");
  if (item.phase === "queued" || item.phase === "resumed") return tr(k(`s14.recovery.reason.${item.phase}`));
  return (item.reason ? trMaybe(`s14.reason.${item.reason}`) : null) ?? tr("s14.reason.generic");
}
function nextLine(item: S14RecoveryItem): string {
  if (item.effect) return tr(item.effect.resolution ? "s14.recovery.effect_stated" : "s14.recovery.effect_next");
  if (item.phase === "queued" || item.phase === "resumed") return tr(k(`s14.recovery.next.${item.phase}`));
  return (item.reason ? trMaybe(`s14.recovery.next.${item.reason}`) : null) ?? tr("s14.recovery.next.generic");
}
function actions(item: S14RecoveryItem): string {
  const open = `<a class="s-link-text" href="${workHref(item)}">${tr("s14.recovery.open_work")}</a>`;
  if (item.effect && !item.effect.resolution) return `<a class="s-btn" href="/effects/${e(item.effect.id)}#slip">${tr("s14.statement.open")}</a>${open}`;
  const fresh = item.group === "closed" || (item.group === "needs" && !item.effect) ? `<a class="s-link-text" href="${redoHref(item)}">${tr("s14.recover.start_new")}</a>` : "";
  const reports = item.reports ? `<a class="s-link-text" href="${workHref(item)}?tab=report">${tr("s14.recovery.kept")} ${item.reports}</a>` : "";
  return `${open}${reports}${fresh}`;
}
function itemCard(page: S14Page, item: S14RecoveryItem): string {
  const steps = item.steps.length ? `<p class="s-meta">${tr("s14.recovery.steps")}: ${item.steps.map(step => e(stepName(page, step))).join(" · ")}</p>` : "";
  const exact = item.effect ? `<p class="s-exact-label">${tr("s14.effect.destination")}</p><pre class="s-exact">${e(item.effect.action.destination)}</pre>` : "";
  const code = item.reason && !item.effect ? `<p class="s-mono s-meta">${e(item.reason)}</p>` : "";
  return `<article class="s-mem s-recovery" aria-label="${e(item.work.title)}"><div class="s-mem-hd"><b class="s-recovery-t">${e(headline(item))}</b><span class="s-grow"></span>${phasePill(item)}</div><p class="s-recovery-work">${e(item.work.title)}</p>${steps}${exact}<p class="s-sub">${e(nextLine(item))}</p>${code}<div class="s-mem-acts">${actions(item)}</div></article>`;
}
function group(page: S14Page, view: S14RecoverySurface, name: S14RecoveryGroup): string {
  const items = view.items.filter(item => item.group === name); if (!items.length) return "";
  return `<section class="s-stack" aria-labelledby="s14-recovery-${name}"><div class="s-group-hd"><h2 class="s-section-t" id="s14-recovery-${name}">${tr(k(`s14.recovery.group.${name}`))}</h2><p class="s-note">${tr(k(`s14.recovery.group.${name}_note`))}</p></div>${items.map(item => itemCard(page, item)).join("")}${name === "resumed" && view.omitted ? `<p class="s-note">${tr("s14.recovery.older")}: ${view.omitted}</p>` : ""}</section>`;
}
/** Unresolved session: what is known, what was tried and that nothing was concluded. The inventory rows are what it last saw, not current facts. */
function sessionCard(page: S14Page, { intent, work }: S14RecoverySession): string {
  const bot = intent.botId ? botName(page.state.bots.find(item => item.id === intent.botId) ?? { id: intent.botId, name: intent.botId }) : null;
  const owner = work ? `<a class="s-link-text" href="/work/${e(work.id)}">${e(work.title)}</a>` : intent.attemptId ? tr("s14.recovery.session.unknown_owner") : tr("s14.recovery.session.chat");
  const seen = intent.discovered.length ? intent.discovered.map(item => tr(k(`s14.recovery.session.seen_${item.state}`))).join(" · ") : tr("s14.recovery.session.seen_none");
  const reason = (intent.reason ? trMaybe(`s14.reason.${intent.reason}`) : null) ?? tr("s14.recovery.session.reason_generic");
  return `<article class="s-slip" data-state="unknown" aria-label="${tr("s14.recovery.session.title")}"><div class="s-slip-hd"><div><h3>${tr("s14.recovery.session.title")}</h3><p class="s-meta">${e(reason)}</p></div>${pill(tr("s14.recovery.session.pill"), "danger", "?")}</div><div class="s-slip-body"><p class="s-sub">${tr("s14.recovery.session.detail")}</p><dl class="s-kv"><dt>${tr("s14.recovery.session.owner")}</dt><dd>${bot ? `${e(bot)} · ` : ""}${owner}</dd><dt>${tr("s14.recovery.session.plan")}</dt><dd>${tr(intent.mode === "delete" ? "s14.recovery.session.plan_delete" : "s14.recovery.session.plan_retire")}</dd><dt>${tr("s14.recovery.session.seen")}</dt><dd>${seen}</dd>${intent.computer ? `<dt>${tr("s14.proposal.computer")}</dt><dd>${tr("s14.recovery.session.computer")}</dd>` : ""}</dl><p class="s-sub">${tr("s14.recovery.session.next")}</p>${intent.reason ? `<p class="s-mono s-meta">${e(intent.reason)}</p>` : ""}</div></article>`;
}
function settled(view: S14RecoverySurface): string {
  const rows = (["retired", "deleted", "not_created", "in_use"] as const).filter(name => view.settled[name]);
  if (!rows.length) return "";
  return `<details class="s-card s-more"><summary>${tr("s14.recovery.settled")}</summary><div><dl class="s-kv">${rows.map(name => `<dt>${tr(k(`s14.recovery.settled_${name}`))}</dt><dd>${view.settled[name]}</dd>`).join("")}</dl><p class="s-note">${tr("s14.recovery.settled_note")}</p></div></details>`;
}
function counts(view: S14RecoverySurface): string {
  const size = (name: S14RecoveryGroup) => view.items.filter(item => item.group === name).length + (name === "resumed" ? view.omitted : 0);
  const row = (name: string, value: number) => `<div><dt>${tr(k(`s14.recovery.count.${name}`))}</dt><dd><b>${value}</b></dd></div>`;
  return `<dl class="s-facts s-recovery-counts">${row("needs", size("needs"))}${row("waiting", size("waiting"))}${row("resumed", size("resumed"))}${row("sessions", view.sessions.length)}</dl>`;
}
/** `/recovery`. It holds links only: every owner decision stays on the card or work page that already pins its revision. */
export function recoveryPage(page: S14Page, view: S14RecoverySurface): string {
  const empty = !view.items.length && !view.sessions.length, live = view.items.some(item => item.phase === "queued");
  const sessions = view.sessions.length ? `<section class="s-stack" aria-labelledby="s14-recovery-sessions"><h2 class="s-section-t" id="s14-recovery-sessions">${tr("s14.recovery.count.sessions")}</h2>${view.sessions.map(item => sessionCard(page, item)).join("")}</section>` : "";
  const body = empty ? banner("", tr("s14.recovery.empty_title"), tr("s14.recovery.empty_detail")) : `${counts(view)}${group(page, view, "needs")}${sessions}${group(page, view, "waiting")}${group(page, view, "resumed")}${group(page, view, "closed")}`;
  return shell(page, tr("s14.recovery.title"), `<div class="s-col"><p class="s-sub">${tr("s14.recovery.lead")}</p><p class="s-sub">${tr("s14.recovery.booted")} ${when(view.bootedAt)}</p><div class="s-stack" id="s14-live"><span hidden data-phase="${e(`${tr("s14.recovery.title")} · ${view.items.length}`)}"></span>${body}</div><p class="s-note">${tr("s14.recovery.usage")} · <span class="s-hatch-word">${tr("s14.unknown")}</span></p>${settled(view)}</div>`, { current: "more", subtitle: tr("s14.recovery.subtitle"), live });
}
