import { tr, trMaybe } from "../../i18n";
import { ownerStrip } from "../../s14/web-pages";
import type { ConversationNeedsYou } from "../conversation";
import type { VmStatus } from "../vm";
import type { ResponsibilityProjection } from "../work";
import { compactSlip, type S15SlipDecision } from "./actions";
import { browserNeedsYou, loginCard, type S15BrowserInfo, type S15BrowserProgress } from "./browser";
import { dutyCard } from "./duties";
import { banner, clock, codeText, e, fill, form, hidden, key, notYet, pill, refusal } from "./render";
import type { S15AccountRow, S15AdoptionStatus, S15TeamCandidate, S15TeamResource } from "./types";

/** One Needs-you entry with the conversation it belongs to. */
export interface S15NeedItem { conversationId: string; entry: ConversationNeedsYou }

/**
 * Needs you (handoff §3, F4, F6, F9, Q6): held actions with their compact exact slips, questions, unknown
 * outcomes, website sign-ins, paused responsibilities and, lowest, out-of-purpose proposals. Durable CI and
 * review waits never appear here.
 */
export function needsBody(input: { items: S15NeedItem[]; decisions: S15SlipDecision[]; duties: ResponsibilityProjection[]; browsers: { browser: S15BrowserInfo; state: S15BrowserProgress | undefined }[]; csrf: string }): string {
  const group = (id: string, title: string, body: string) => body ? `<section class="s-attention-group" aria-labelledby="s15-needs-${id}"><h2 id="s15-needs-${id}">${title}</h2>${body}</section>` : "";
  const entries = (kind: ConversationNeedsYou["kind"]) => input.items.filter(item => item.entry.kind === kind).map(({ conversationId, entry }) => {
    if (entry.slip) return `<div class="s15-need" id="${e(entry.id)}">${compactSlip(entry.slip, input.decisions.filter(d => d.row.decision?.action.id === entry.slip!.action.id))}</div>`;
    const state = kind === "reconciliation" ? "unknown" : kind === "question" ? "question" : entry.code === "budget_exhausted" || entry.code === "finite_budget_required" ? "budget_hold" : "needs_you";
    const budget = state === "budget_hold" ? `<p><a class="s-link-text" href="/models">${tr("s15.budget.raise")}</a></p>` : "";
    return `<div class="s15-need" id="${e(entry.id)}"><a class="s15-need-link" href="/chats/${e(conversationId)}#s15-row-${e(entry.requestId)}"><span>${e(codeText(entry.code))}</span>${pill(tr(key(`s15.state.${state}`)), state === "unknown" ? "danger" : "warn", state === "unknown" ? "?" : "!")}</a>${budget}</div>`;
  }).join("");
  const logins = input.browsers.filter(({ state }) => browserNeedsYou(state) || input.items.some(item => item.entry.code === "login_required")).map(({ browser, state }) => loginCard(browser, state, input.csrf)).join("");
  const paused = input.duties.filter(d => d.state === "paused" || d.state === "reconcile_only" || (d.state === "waiting" && d.wait?.kind === "owner")).map(d => dutyCard(d, input.csrf)).join("");
  const proposals = input.duties.filter(d => d.proposals.length && !["stopped", "completed"].includes(d.state)).map(d => `<p><a class="s-link-text" href="/duties/${e(d.id)}">${tr("s15.duty.outside")} · ${fill("s15.duty.proposals", { n: d.proposals.length })}</a></p>`).join("");
  const body = group("action", tr("s15.needs.group.action"), entries("action")) + group("question", tr("s15.needs.group.question"), entries("question")) + group("reconciliation", tr("s15.needs.group.reconciliation"), entries("reconciliation"))
    + group("login", tr("s15.needs.group.login"), logins) + group("stalled", tr("s15.needs.group.stalled"), paused) + group("proposals", tr("s15.needs.group.proposals"), proposals);
  return `<div class="s-col s-attention-groups">${body || `<p class="s-sub">${tr("s15.needs.none")}</p>`}<p class="s-note">${tr("s15.needs.decide_note")}</p></div>`;
}

/** One TEAM15 restriction code in words. `deny:<bot>` and `purpose:<id>` carry trusted registry ids; unknown codes stay visible as codes. */
function restriction(code: string): string {
  if (code.startsWith("deny:")) return e(fill("s15.resources.restriction.deny", { bot: code.slice(5) }));
  if (code.startsWith("purpose:")) return e(fill("s15.resources.restriction.purpose", { purpose: code.slice(8) }));
  if (code === "s14_private") return "";
  return e(trMaybe(`s15.resources.restriction.${code}`) ?? code);
}
/**
 * F1 section 5 and F12: resources the rules and working computer refer to that the team cannot use yet.
 * Every row is shown exactly as it would be registered; one owner confirmation registers that list and
 * nothing else. Registration grants no sending, paying or publishing; standing rules still gate effects.
 */
export function teamPendingCard(input: { pending: { items: S15TeamCandidate[]; hash: string } | null; csrf: string; back: "setup" | "resources"; registered: boolean; refused: string | null }): string {
  const done = input.registered ? `<div role="status">${banner("ok", tr("s15.team_register.done"))}</div>` : "";
  const items = input.pending?.items ?? [];
  if (!items.length) return `${done}${refusal(input.refused)}`;
  const id = `s15-team-pending-${input.back}`;
  const who = (item: S15TeamCandidate) => item.scope.kind === "bot" ? fill("s15.resources.only", { bots: item.scope.botId }) : item.allowedBots === null ? tr("s15.resources.team") : fill("s15.resources.only", { bots: item.allowedBots.join(", ") });
  const rows = items.map(item => `<li><div class="s-grow"><p><b>${e(item.label)}</b> <span class="s-meta">${tr(key(`s15.resources.kind.${item.kind}`))}</span></p><p class="s-meta">${item.operations.map(op => tr(key(`s15.resources.op.${op}`))).join(" · ")} · ${e(who(item))} · ${fill("s15.team_register.revision", { n: item.revision })}</p>${item.purposes.length ? `<p class="s-sub">${item.purposes.map(purpose => fill("s15.resources.restriction.purpose", { purpose })).join(" · ")}</p>` : ""}</div>${pill(tr("s15.team_register.pending"), "warn", "!")}</li>`).join("");
  const confirm = form("/s15/forms/team/register", input.csrf, `${hidden("listHash", input.pending!.hash)}${hidden("return", input.back)}<button class="s-btn primary" aria-describedby="${id}-note">${fill("s15.team_register.confirm", { n: items.length })}</button>`);
  return `${done}${refusal(input.refused)}<section class="s-stack s15-team-pending" aria-labelledby="${id}"><h3 class="s-section-t" id="${id}">${tr("s15.team_register.title")}</h3><p>${tr("s15.team_register.lead")}</p><ul class="s15-accounts">${rows}</ul><p class="s-note" id="${id}-note">${tr("s15.team_register.note")}</p><div class="s-row">${confirm}</div></section>`;
}

/** `/resources/accounts` (F12): team resources with who may use them, S14-private labels, and website sign-ins. */
export function accountsBody(input: { team: S15TeamResource[] | null; accounts: S15AccountRow[] | null; browsers: { browser: S15BrowserInfo; state: S15BrowserProgress | undefined }[]; csrf: string; teamPending?: string }): string {
  const who = (r: S15TeamResource) => r.scope.kind === "bot" && r.scope.origin === "s14" ? fill("s15.memory.s14_private", { bot: r.scope.botId }) : r.whoCanUse === "enabled_team" ? tr("s15.resources.team") : fill("s15.resources.only", { bots: r.whoCanUse.join(", ") });
  const team = input.team === null ? notYet("s15.resources.not_composed") : input.team.length ? `<ul class="s15-accounts">${input.team.map(r => `<li><div class="s-grow"><p><b>${e(r.label)}</b> <span class="s-meta">${tr(key(`s15.resources.kind.${r.kind}`))}</span></p><p class="s-meta">${r.operations.map(op => tr(key(`s15.resources.op.${op}`))).join(" · ")} · ${e(who(r))}</p>${r.restrictions.length ? `<p class="s-sub">${r.restrictions.map(restriction).filter(Boolean).join(" · ")}</p>` : ""}${r.scope.kind === "bot" && r.scope.origin === "s14" ? `<p class="s-note">${tr("s15.resources.no_broad_share")}</p>` : ""}</div>${pill(tr(r.active ? "s15.resources.active" : "s15.resources.inactive"), r.active ? "ok" : "", r.active ? "✓" : "")}</li>`).join("")}</ul>` : `<p class="s-sub">${tr("s15.resources.none")}</p>`;
  const accounts = input.accounts?.length ? `<ul class="s15-accounts">${input.accounts.map(a => `<li><div class="s-grow"><p><b>${e(a.label)}</b></p><p class="s-meta">${a.uses.map(use => tr(key(`s15.accounts.use.${use}`))).join(" · ")}</p></div>${pill(tr(key(`s15.accounts.state.${a.state}`)))}</li>`).join("")}</ul>` : `<p class="s-sub">${tr("s15.resources.no_accounts")}</p>`;
  const sites = input.browsers.length ? input.browsers.map(({ browser, state }) => loginCard(browser, state, input.csrf)).join("") : `<p class="s-sub">${tr("s15.resources.no_sites")}</p>`;
  return `<div class="s-col"><section class="s-card" aria-labelledby="s15-res-team"><h2 id="s15-res-team">${tr("s15.resources.team_title")}</h2>${input.teamPending ?? ""}${team}</section>
    <section class="s-card" aria-labelledby="s15-res-accounts"><h2 id="s15-res-accounts">${tr("s15.resources.accounts_title")}</h2>${accounts}</section>
    <section class="s-card" aria-labelledby="s15-res-sites"><h2 id="s15-res-sites">${tr("s15.resources.sites_title")}</h2>${sites}<p class="s-note">${tr("s15.resources.sign_in_note")}</p></section></div>`;
}

/** F11 restore: lists retained snapshots; the restore slip states its impact and waits for the owner (Q3). */
export function restoreSection(input: { csrf: string; status: VmStatus | null; snapshots: { id: string; generation: number }[] | null; selected: string | null; hypervisor: string | null; refused: string | null; restored: boolean;
  /** POOL15-01: an additional pool member; its ids, links and form carry the exact member. Absent: the default computer. */
  member?: { id: string; name: string } }): string {
  if (!input.status) return "";
  const member = input.member, suffix = member ? `-${member.id}` : "", vmQuery = member ? `&amp;vm=${e(member.id)}` : "";
  const title = `<h2 id="s15-restore-title${e(suffix)}">${member ? fill("s15.pool.restore_title", { name: member.name }) : tr("s15.vm.restore_title")}</h2>`;
  const broken = input.status.state === "uncertain" ? banner("danger", tr("s15.vm.broken"), input.status.reason ? codeText(input.status.reason) : "") : input.status.state === "stopped" ? banner("warn", tr("s15.vm.not_responding")) : "";
  if (input.snapshots === null || !input.status.recoveryAvailable) return `<section class="s-card" aria-labelledby="s15-restore-title${e(suffix)}">${title}${broken}<p class="s-sub">${fill("s15.vm.no_snapshot", { hypervisor: input.hypervisor ?? "Proxmox / Lima" })}</p></section>`;
  const done = input.restored ? `<div role="status">${banner("ok", tr("s15.vm.restored"), tr("s15.vm.restored_detail"))}</div>` : "";
  const chosen = input.selected ? input.snapshots.find(s => s.id === input.selected) ?? null : null;
  if (chosen) {
    return `<div class="s-col">${refusal(input.refused)}<article class="s-slip s15-slip" data-state="open" aria-labelledby="s15-slip-title"><div class="s-slip-hd"><div><h2 id="s15-slip-title" tabindex="-1">${tr("s15.hold.asks.restore")}</h2><div class="s15-chips"><span class="s-chip">${tr("s15.class.guest_system_admin")}</span></div></div>${pill(tr("s15.state.needs_you"), "warn", "!")}</div>
      <div class="s-slip-body"><dl class="s-kv"><dt>${tr("s15.vm.snapshot")}</dt><dd class="s-mono">${e(chosen.id)}</dd><dt>${tr("s15.vm.snapshot_generation")}</dt><dd>${fill("s15.computer.generation", { n: chosen.generation })}</dd><dt>${tr("s15.vm.current_generation")}</dt><dd>${fill("s15.computer.generation", { n: input.status.generation })}</dd></dl>
      <h4 class="s-section-t">${tr("s15.vm.restore_loses")}</h4><ul class="s15-list"><li>${tr("s15.vm.lose.files")}</li><li>${tr("s15.vm.lose.programs")}</li><li>${tr("s15.vm.lose.services")}</li></ul><h4 class="s-section-t">${tr("s15.vm.restore_not_affected")}</h4><p>${tr("s15.vm.restore_keeps")}</p><p>${tr("s15.vm.restore_stops_work")}</p><p class="s-note">${tr("s15.vm.restore_owner_only")}</p></div>
      ${ownerStrip(`${form("/s15/forms/computer/restore", input.csrf, `${member ? hidden("vmId", member.id) : ""}${hidden("snapshotId", chosen.id)}${hidden("generation", input.status.generation)}<button class="s-btn primary">${tr("s15.vm.restore_once")}</button>`)}<a class="s-btn" href="/resources/computer">${tr("s15.common.cancel")}</a>`, tr("s15.hold.single_use"))}</article></div>`;
  }
  const rows = input.snapshots.length ? `<ul class="s15-facts">${input.snapshots.map((s, index) => `<li><span class="s-mono">${e(s.id)}</span> · ${fill("s15.computer.generation", { n: s.generation })}${index === 0 ? ` · ${tr("s15.vm.latest")}` : ""} <a class="s-link-text" href="/resources/computer?restore=${e(s.id)}${vmQuery}#s15-slip-title">${tr("s15.vm.restore_to")}</a></li>`).join("")}</ul>` : `<p class="s-sub">${tr("s15.vm.no_snapshots_yet")}</p>`;
  return `<section class="s-card" aria-labelledby="s15-restore-title${e(suffix)}">${title}${done}${refusal(input.refused)}${broken}${rows}<p class="s-note">${tr("s15.vm.restore_owner_only")}</p></section>`;
}

/** `/recovery` (F11): what is still open after a restart, unknown actions with read-only checks, and adoption status. */
export function recoveryBody(input: { unknown: S15NeedItem[]; decisions: S15SlipDecision[]; pending: number; adoption: S15AdoptionStatus | null; adoptionAvailable: boolean }): string {
  const summary = `<p>${fill("s15.recovery.summary", { work: input.pending, actions: input.unknown.length })}</p>`;
  const unknown = input.unknown.length ? input.unknown.map(({ entry }) => entry.slip ? compactSlip(entry.slip, input.decisions.filter(d => d.row.decision?.action.id === entry.slip!.action.id)) : "").join("") : `<p class="s-sub">${tr("s15.recovery.no_unknown")}</p>`;
  const a = input.adoption;
  const adoption = !input.adoptionAvailable ? notYet("s15.adoption.not_composed") : !a ? `<p>${tr("s15.adoption.not_started")}</p>` : `<dl class="s-kv"><dt>${tr("s15.adoption.runtime")}</dt><dd>${tr(key(`s15.adoption.runtime.${a.selectedRuntime}`))}</dd><dt>${tr("s15.adoption.state")}</dt><dd>${tr(key(`s15.adoption.state.${a.state}`))}${a.reason ? ` · ${e(codeText(a.reason))}` : ""}</dd>
    <dt>${tr("s15.adoption.build")}</dt><dd class="s-mono s15-break">${e(a.report.targetBuild.commit)} · ${e(a.report.targetBuild.sha256.slice(0, 16))}</dd></dl><ul class="s15-list"><li>${fill("s15.adoption.keeps_history", { n: a.report.historyRows })}</li><li>${fill("s15.adoption.keeps_private", { n: a.report.privateItems })}</li><li>${tr("s15.adoption.rollback_point")}</li>${a.report.unknownEffects ? `<li>${fill("s15.adoption.unknown_effects", { n: a.report.unknownEffects })}</li>` : ""}</ul><p class="s-note">${tr("s15.adoption.command_elsewhere")}</p>`;
  return `<div class="s-col"><section class="s-card" aria-labelledby="s15-recovery-t"><h2 id="s15-recovery-t">${tr("s15.recovery.title")}</h2>${summary}${unknown}<p class="s-note">${tr("s15.recovery.no_resend")}</p></section>
    <section class="s-card" aria-labelledby="s15-adoption-t"><h2 id="s15-adoption-t">${tr("s15.adoption.title")}</h2>${adoption}</section></div>`;
}
