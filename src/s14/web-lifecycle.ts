import { tr, trMaybe, type MessageKey } from "../i18n";
import type { BotLifecycle, BotLifecyclePreview, CapabilityProposal } from "./bot-lifecycle-types";
import type { RoutineView } from "./routine-types";
import type { Bot, Capabilities } from "./types";
import type { S14Page } from "./web";
import { banner, botName, commandForm, computerPath, e, flat, hidden, k, notice, ownerStrip, pill, shell } from "./web-pages";
import { reach } from "./web-memory";
import { shareQuery, type S14BotEnd, type S14BotLanding, type S14BotPolicy, type S14LifecycleSurface, type S14ShareReturn } from "./web-product-lifecycle";

/* Bot lifecycle (BOT14-02, resolution Q7). Accepting a ceiling, retiring and deleting are exact owner commands, and a receipt is intent: the page keeps saying stopping until transports really settle. Computer reset stays on the computer tab. */
const stateTone: Record<BotLifecycle["state"], [string, string]> = { active: ["", ""], stopping: ["", ""], retired: ["", ""], deleting: ["warn", "!"], deleted: ["", ""] };
/** The one word for a Bot's lifecycle, the same on every surface. */
export const lifecyclePill = (lifecycle: BotLifecycle) => pill(tr(k(`s14.life.state.${lifecycle.state}`)), ...stateTone[lifecycle.state]);
const mono = (items: string[]) => items.length ? items.map(item => `<span class="s-mono">${e(item)}</span>`).join(" · ") : tr("s14.bot.none");
const stages: BotLifecycle["stage"][] = ["fenced", "data", "computer", "native", "complete"];
const managedSlot = (id: string) => /^share_slot_[0-9]{2}$/.test(id);
const live = (bot: Pick<Bot, "id">, page: S14Page) => page.overview.views.filter(view => view.grant?.bots.some(item => item.id === bot.id) && ["queued", "running", "waiting", "blocked"].includes(view.work.state));
const openRoutines = (routines: RoutineView[]) => routines.filter(view => view.routine.state === "active" || view.routine.state === "paused");
/** Link to the share sheet the owner came from; a read that can only show the sheet again. */
const shareBack = (target: S14ShareReturn) => `/shares/new?${e(shareQuery(target))}#slip`;
/** Link that prefills one free slot in a Bot's capability form. It only opens the form, and the owner still reviews and accepts. */
export const slotHref = (bot: Pick<Bot, "id">, target: S14ShareReturn | null = null) => `/team/${e(bot.id)}/capabilities?add=slot&amp;edit=1${target ? `&amp;${e(shareQuery(target))}` : ""}`;

/** Steps of a stop. A step reads done only when the stored stage has passed it; the rest are words, never a percentage. */
function stepList(lifecycle: BotLifecycle): string {
  const reached = stages.indexOf(lifecycle.stage), names = ["fenced", "calls", "computer", "sessions"] as const;
  const word = (index: number) => index <= reached ? "done" : index === reached + 1 ? "now" : "later";
  return `<ol class="s-steps">${names.map((name, index) => `<li data-step="${word(index)}"><span>${tr(k(`s14.life.step.${name}`))}</span><small>${tr(k(`s14.life.step_word.${word(index)}`))}</small></li>`).join("")}</ol>`;
}
/** Live status of a transition. It reads the lifecycle record and never infers a finish from the receipt. */
function stopping(lifecycle: BotLifecycle): string {
  const why = lifecycle.reason ? `<p class="s-sub">${tr(k(`s14.life.reason.${lifecycle.reason}`))}</p><p class="s-mono s-meta">${e(lifecycle.reason)}</p>` : "";
  return `<article class="s-slip" data-state="${lifecycle.reason ? "pending" : "closed"}" aria-label="${tr(k(`s14.life.state.${lifecycle.state}`))}"><div class="s-slip-hd"><div><h2>${tr(k(`s14.life.stopping.${lifecycle.target}`))}</h2><p class="s-meta">${tr("s14.life.stopping_meta")}</p></div>${lifecyclePill(lifecycle)}</div><div class="s-slip-body">${stepList(lifecycle)}${why}</div></article>`;
}
const settling = (lifecycle: BotLifecycle) => lifecycle.state === "stopping" || lifecycle.state === "deleting";
/** The status block for every Bot page; empty for a plain active Bot. */
export function lifecycleStatus(bot: Bot, lifecycle: BotLifecycle): string {
  if (settling(lifecycle)) return stopping(lifecycle);
  if (lifecycle.state === "retired") return banner("", tr("s14.life.state.retired"), tr("s14.life.retired_detail"), `<p class="s-row"><a class="s-link-text" href="/team/${e(bot.id)}/capabilities">${tr("s14.life.reenable")}</a><a class="s-link-text" href="/team/${e(bot.id)}/delete">${tr("s14.life.delete")}</a></p>`);
  if (lifecycle.state === "deleted") return banner("", tr("s14.life.state.deleted"), tr("s14.life.deleted_detail"));
  return "";
}
/** Landing words on the Bot page, from a reread receipt, plus the way back to the share sheet once the Bot is really active. */
export function lifecycleLanding(bot: Bot, lifecycle: BotLifecycle, landing: S14BotLanding | null): string {
  if (!landing) return "";
  const done = landing.receipt ? banner("", tr(k(`s14.life.done.${landing.receipt.kind.slice("bot.".length).replaceAll(".", "_")}`)), tr(settling(lifecycle) ? "s14.life.done_intent" : "s14.life.done_settled")) : "";
  const back = landing.back ? lifecycle.state === "active" && bot.enabled ? `<p><a class="s-btn primary" href="${shareBack(landing.back)}">${tr("s14.life.back_to_share")}</a></p>` : settling(lifecycle) ? `<p class="s-note">${tr("s14.life.back_wait")}</p>` : "" : "";
  const account = landing.account ? lifecycle.state === "active" && bot.enabled ? `<p><a class="s-btn primary" href="/settings/google/connections/${e(landing.account)}">${tr("s14.life.back_to_account")}</a></p>` : settling(lifecycle) ? `<p class="s-note">${tr("s14.life.back_wait")}</p>` : "" : "";
  return `${done}${back}${account}`;
}
/** True while the page should keep rereading: only a real transition, never a Bot at rest. */
export const lifecycleLive = (lifecycle: BotLifecycle | undefined) => !!lifecycle && settling(lifecycle);

const toolWord = (tool: string) => trMaybe(`s14.life.tool.${tool}`);
function toolChoices(page: S14Page, bot: Bot, chosen: Capabilities): string {
  const tools = [...new Set([...page.policy.tools, ...bot.capabilities.tools])];
  if (!tools.length) return `<p class="s-note">${tr("s14.proposal.no_capabilities")}</p>`;
  return `<fieldset class="s-field"><legend>${tr("s14.bot.tools")}</legend>${tools.map(tool => `<label class="s-check"><input type="checkbox" name="tool:${e(tool)}" value="on"${chosen.tools.includes(tool) ? " checked" : ""}><span>${toolWord(tool) ? `${toolWord(tool)} <span class="s-mono s-meta">${e(tool)}</span>` : `<span class="s-mono">${e(tool)}</span>`}</span></label>`).join("")}</fieldset>`;
}
/** Slots this form offers: everything held, every configured resource, and the next few free built-in slots rather than all 64. */
function resourceChoices(view: S14BotPolicy, chosen: Capabilities, added: string | null): string {
  const free = new Map(view.slots.map(slot => [slot.scopeId, slot])), held = view.bot.capabilities.resources, offered = [...view.slots].filter(slot => !held.includes(slot.scopeId));
  const named = offered.filter(slot => !managedSlot(slot.scopeId)).map(slot => slot.scopeId), next = offered.filter(slot => managedSlot(slot.scopeId)).sort((a, b) => a.receiverBotIds.length - b.receiverBotIds.length).map(slot => slot.scopeId).slice(0, 3);
  const row = (id: string) => { const note = held.includes(id) && !free.has(id) ? "s14.life.slot_used" : managedSlot(id) ? "s14.life.slot_free" : "s14.life.resource"; return `<label class="s-check"><input type="checkbox" name="resource:${e(id)}" value="on"${chosen.resources.includes(id) || id === added ? " checked" : ""}><span class="s-mono">${e(id)}<small>${tr(note)}</small></span></label>`; };
  const ids = [...new Set([...held, ...chosen.resources, ...named, ...next])];
  return `<fieldset class="s-field"><legend>${tr("s14.bot.resources")}</legend>${ids.map(row).join("") || `<p class="s-note">${tr("s14.life.no_slots")}</p>`}<p class="s-note">${tr("s14.life.slot_note")}</p></fieldset>`;
}
/** The first slot a "needs a slot" link pretick. It is a suggestion in plain sight: the owner still reads the exact proposal. */
function suggested(view: S14BotPolicy): string | null {
  if (!view.addSlot) return null;
  const held = view.bot.capabilities.resources;
  return view.slots.filter(slot => !held.includes(slot.scopeId) && !slot.receiverBotIds.includes(view.bot.id)).sort((a, b) => a.receiverBotIds.length - b.receiverBotIds.length)[0]?.scopeId ?? null;
}
/** Draft form. Every box is the exact selection sent, including what stays, so nothing is inferred. */
function draftForm(page: S14Page, view: S14BotPolicy): string {
  const { bot, lifecycle } = view, reenable = lifecycle.state === "retired", chosen = view.draft ?? bot.capabilities, form = reenable ? "capability-reenable" : "capability-propose";
  return `<section class="s-card s-stack" aria-labelledby="s14-life-draft"><h2 id="s14-life-draft">${tr(reenable ? "s14.life.reenable_title" : "s14.life.draft_title")}</h2><p class="s-sub">${tr(reenable ? "s14.life.reenable_lead" : "s14.life.draft_lead")}</p><form class="s-stack" method="post" action="/s14/forms/${form}">${flat(page.csrf, bot.revision)}${hidden("botId", bot.id)}${view.back ? hidden("share", shareQuery(view.back)) : ""}${view.account ? hidden("account", view.account) : ""}${toolChoices(page, bot, chosen)}${resourceChoices(view, chosen, suggested(view))}<div><button class="s-btn primary">${tr("s14.life.review")}</button></div></form></section>`;
}
/** One side of the before and after, listing the exact set in mono so a change can be checked by eye. */
const side = (label: string, value: Capabilities) => `<div><p class="s-exact-label">${e(label)}</p><pre class="s-exact">${e(`${tr("s14.bot.tools")}\n${value.tools.join("\n") || tr("s14.bot.none")}\n\n${tr("s14.bot.resources")}\n${value.resources.join("\n") || tr("s14.bot.none")}`)}</pre></div>`;
function changeRows(before: Capabilities, after: Capabilities): { rows: string; changed: boolean } {
  const line = (word: string, cls: string, id: string, note: string | null) => `<li class="${cls}"><span>${e(word)}</span><span class="s-mono">${e(id)}</span>${note ? `<small>${e(note)}</small>` : ""}</li>`;
  const added = (a: string[], b: string[]) => b.filter(item => !a.includes(item)), note = (id: string, gained: boolean) => gained ? trMaybe(`s14.life.gain.${id}`) ?? (id.startsWith("effect_") ? tr("s14.grant.effect_tool") : managedSlot(id) ? tr("s14.life.gain.slot") : null) : managedSlot(id) ? tr("s14.life.lose.slot") : null;
  const rows = [...added(before.tools, after.tools).map(id => line(tr("s14.life.adds"), "s-diff-new", id, note(id, true))), ...added(before.resources, after.resources).map(id => line(tr("s14.life.adds"), "s-diff-new", id, note(id, true))), ...added(after.tools, before.tools).map(id => line(tr("s14.life.removes"), "s-diff-old", id, note(id, false))), ...added(after.resources, before.resources).map(id => line(tr("s14.life.removes"), "s-diff-old", id, note(id, false)))];
  return { rows: rows.join(""), changed: rows.length > 0 };
}
/** Everything acceptance interrupts, named. A title here is escaped data in a link, never in the strip. */
function impactBlock(page: S14Page, bot: Bot, routines: RoutineView[]): string {
  const work = live(bot, page), standing = openRoutines(routines), computer = page.overview.computers[bot.id]?.computer, running = computer && ["running", "starting"].includes(computer.state);
  const workRows = work.map(view => `<a class="s-work-row" href="/work/${e(view.work.id)}"><span><span>${e(view.work.title)}</span></span>${pill(tr(k(`s14.work_state.${view.work.state}`)))}</a>`).join("");
  const routineRows = standing.map(view => `<a class="s-work-row" href="/routines/${e(view.routine.id)}"><span><span>${e(view.routine.capture.command.payload.title)}</span></span>${pill(tr(k(`s14.routine.state.${view.routine.state}`)))}</a>`).join("");
  const none = !work.length && !standing.length && !running ? `<p class="s-sub">${tr("s14.life.impact_none")}</p>` : "";
  return `<section class="s-stack" aria-labelledby="s14-life-impact"><h3 class="s-section-t" id="s14-life-impact">${tr("s14.life.impact_title")}</h3>${none}${work.length ? `<div class="s-stack"><p class="s-sub">${tr("s14.life.impact_work")}</p>${workRows}</div>` : ""}${standing.length ? `<div class="s-stack"><p class="s-sub">${tr("s14.life.impact_routines")}</p>${routineRows}</div>` : ""}${running ? `<p class="s-sub">${tr("s14.life.impact_computer")}</p>` : ""}</section>`;
}
/** The exact proposal slip: before, after, what stops, what is not granted, then the one hash-bound press. */
function proposalSlip(page: S14Page, view: S14BotPolicy, proposal: CapabilityProposal): string {
  const { bot } = view, stale = proposal.state === "proposed" && (proposal.botRevision !== bot.revision || proposal.botGeneration !== bot.generation), reenable = proposal.action === "reenable";
  const { rows, changed } = changeRows(bot.capabilities, proposal.capabilities), open = proposal.state === "proposed" && !stale, pending = open && (changed || reenable);
  const edit = `<a class="s-btn" href="/team/${e(bot.id)}/capabilities?edit=1${view.back ? `&amp;${e(shareQuery(view.back))}` : ""}${view.account ? `&amp;account=${e(view.account)}` : ""}">${tr("s14.life.edit")}</a>`;
  const accept = `<form method="post" action="/s14/forms/capability-accept">${flat(page.csrf, proposal.revision)}${hidden("botId", bot.id)}${hidden("proposalId", proposal.id)}${hidden("proposalHash", proposal.hash)}${view.back ? hidden("share", shareQuery(view.back)) : ""}${view.account ? hidden("account", view.account) : ""}<button class="s-btn primary">${tr(reenable ? "s14.life.accept_reenable" : "s14.life.accept")} · ${e(proposal.hash.slice(0, 8))}</button></form>`;
  const closed = stale ? banner("warn", tr("s14.life.proposal_stale"), tr("s14.life.proposal_stale_detail")) : proposal.state === "superseded" ? banner("", tr("s14.life.proposal_superseded"), tr("s14.life.proposal_stale_detail")) : proposal.state === "accepted" ? banner("", tr("s14.life.proposal_accepted")) : !pending ? banner("", tr("s14.life.proposal_same"), tr("s14.life.proposal_same_detail")) : "";
  const changes = rows && open ? `<div><p class="s-exact-label">${tr("s14.life.what_changes")}</p><ul class="s-cap-diff">${rows}</ul></div>` : "";
  const compare = open ? `<div class="s-cap-sides">${side(tr("s14.life.now"), bot.capabilities)}${side(tr("s14.life.after"), proposal.capabilities)}</div>` : side(tr("s14.life.proposed"), proposal.capabilities);
  const body = `${closed}${reenable && open ? banner("", tr("s14.life.reenable_fresh"), tr("s14.life.reenable_fresh_detail")) : ""}${changes}${compare}${pending ? `${impactBlock(page, bot, view.routines)}${reach(["s14.life.does_1", "s14.life.does_2", "s14.life.does_3"], ["s14.life.not_1", "s14.life.not_2", "s14.life.not_3", "s14.life.not_4"])}` : ""}<dl class="s-kv"><dt>${tr("s14.life.exact")}</dt><dd class="s-mono">p${proposal.revision} · r${proposal.botRevision} · g${proposal.botGeneration}</dd><dt>SHA-256</dt><dd class="s-mono">${e(proposal.hash)}</dd></dl>`;
  const strip = pending ? ownerStrip(`${accept}${edit}`, tr(reenable ? "s14.life.accept_reenable_note" : "s14.life.accept_note")) : open || stale ? `<div class="s-strip">${edit}</div>` : "";
  return `<article class="s-slip"${pending ? "" : ' data-state="closed"'} aria-label="${tr("s14.life.proposal_title")}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${tr(reenable ? "s14.life.proposal_reenable" : "s14.life.proposal_title")}</h2><p class="s-meta">${tr("s14.life.proposal_meta")}</p></div>${pill(tr(k(`s14.life.proposal_state.${stale ? "stale" : proposal.state}`)), pending ? "strong" : "")}</div><div class="s-slip-body">${body}</div>${strip}</article>`;
}
function proposalHistory(view: S14BotPolicy): string {
  const old = view.proposals.filter(item => item.id !== view.proposal?.id).slice(0, 8);
  return old.length ? `<details class="s-card s-more"><summary>${tr("s14.life.history")}</summary><div><ul class="s-history">${old.map(item => `<li><p>${pill(tr(k(`s14.life.proposal_state.${item.state}`)))} <span class="s-mono s-meta">${e(item.hash.slice(0, 12))} · r${item.botRevision}</span></p><p class="s-meta">${mono([...item.capabilities.tools, ...item.capabilities.resources])}</p></li>`).join("")}</ul></div></details>` : "";
}
function endLinks(view: S14BotPolicy): string {
  const { bot, lifecycle } = view, computer = `<a class="s-link-text" href="${computerPath(bot)}">${tr("s14.life.computer_link")}</a>`;
  if (bot.id === "jit") return `<p class="s-note">${tr("s14.life.main_note")}</p>`;
  if (lifecycle.state !== "active") return "";
  return `<section class="s-card s-stack" aria-labelledby="s14-life-end"><h2 id="s14-life-end">${tr("s14.life.end_title")}</h2><p class="s-sub">${tr("s14.life.end_lead")}</p><p class="s-row"><a class="s-btn" href="/team/${e(bot.id)}/retire">${tr("s14.life.retire")}</a><a class="s-btn danger" href="/team/${e(bot.id)}/delete">${tr("s14.life.delete")}</a></p><p class="s-note">${tr("s14.life.computer_note")} ${computer}</p></section>`;
}
const botTabs = (bot: Bot, current: "capabilities" | "end") => `<nav class="s-worktabs" aria-label="${tr("s14.bot.tab_label")}"><a href="/team/${e(bot.id)}">${tr("s14.bot.tab_overview")}</a><a href="${computerPath(bot)}">${tr("s14.tab.computer")}</a><a href="/team/${e(bot.id)}/capabilities"${current === "capabilities" ? ' aria-current="page"' : ""}>${tr("s14.bot.tab_capabilities")}</a></nav>`;
function policyPage(page: S14Page, view: S14BotPolicy): string {
  const { bot, lifecycle, proposal } = view, editable = lifecycle.state === "active" || lifecycle.state === "retired";
  const current = `<dl class="s-kv"><dt>${tr("s14.bot.tools")}</dt><dd>${mono(bot.capabilities.tools)}</dd><dt>${tr("s14.bot.resources")}</dt><dd>${mono(bot.capabilities.resources)}</dd><dt>${tr("s14.bot.revision")}</dt><dd class="s-mono">r${bot.revision} · g${bot.generation}</dd></dl>`;
  const main = proposal ? proposalSlip(page, view, proposal) : editable ? `${current}${draftForm(page, view)}` : current;
  return shell(page, botName(bot), `<div class="s-col">${botTabs(bot, "capabilities")}${notice(view.notice)}<div class="s-stack" id="s14-live"><span hidden data-phase="${e(tr(k(`s14.life.state.${lifecycle.state}`)))}"></span>${lifecycleStatus(bot, lifecycle)}</div>${main}${proposalHistory(view)}${endLinks(view)}</div>`, { current: "team", bot, subtitle: tr("s14.bot.tab_capabilities"), live: lifecycleLive(lifecycle) });
}

const twoLists = (first: string, firstItems: MessageKey[], second: string, secondItems: MessageKey[]) => {
  const items = (keys: MessageKey[]) => `<ul class="s-reach-list">${keys.map(key => `<li>${tr(key)}</li>`).join("")}</ul>`;
  return `<div class="s-reach"><div><h3 class="s-section-t">${e(first)}</h3>${items(firstItems)}</div><div><h3 class="s-section-t">${e(second)}</h3>${items(secondItems)}</div></div>`;
};
function counts(preview: BotLifecyclePreview): string {
  const fact = (name: string, value: number) => `<div><dt>${tr(k(`s14.life.count.${name}`))}</dt><dd><b>${value}</b></dd></div>`, { data } = preview;
  return `<dl class="s-facts s-recovery-counts">${fact("chats", preview.conversations.length)}${fact("work", preview.work.length)}${fact("memories", data.claims.length)}${fact("originals", data.sources.length)}${fact("reports", data.reports.length)}${fact("files", data.artifacts.length)}${fact("shares", preview.shares.length)}${fact("routines", preview.routines.length)}</dl>`;
}
/** Every identity the command binds to. Long lists stay complete: this is the record, so nothing is summarised away. */
function manifest(preview: BotLifecyclePreview): string {
  const { data } = preview, ref = (item: { id: string; revision: number; generation?: number }) => `${item.id} r${item.revision}${item.generation ? ` g${item.generation}` : ""}`;
  const sections: [string, string[]][] = [
    ["chats", preview.conversations.map(ref)], ["work", preview.work.map(ref)], ["originals", data.sources.map(ref)], ["memories", data.claims.map(ref)], ["contexts", data.contexts], ["reports", data.reports.map(ref)], ["files", data.artifacts],
    ["shares", preview.shares.map(item => `${item.kind} ${ref(item)}`)], ["computer", preview.computer ? [ref(preview.computer), `workspace ${preview.computer.workspaceId}`, `profile ${preview.computer.profileId}`] : []],
    ["sessions", preview.native.map(item => `${item.id} ${item.state} ${item.mode} → ${item.cleanup}`)], ["routines", preview.routines.map(item => `${ref(item)} ${item.state}`)], ["withdrawals", preview.withdrawals.map(item => `${item.kind} ${item.id} ${item.mode}`)], ["effects", preview.retainedEffects.map(item => `${ref(item)} ${item.state} ${item.actionHash}`)],
  ];
  const rows = sections.filter(([, lines]) => lines.length).map(([name, lines]) => `<div><p class="s-exact-label">${tr(k(`s14.life.count.${name}`))}</p><pre class="s-exact">${e(lines.join("\n"))}</pre></div>`).join("");
  return `<details class="s-more"><summary>${tr("s14.life.manifest")}</summary><div>${rows || `<p class="s-note">${tr("s14.life.manifest_empty")}</p>`}<dl class="s-kv"><dt>${tr("s14.life.exact")}</dt><dd class="s-mono">r${preview.bot.revision} · g${preview.bot.generation}</dd><dt>SHA-256</dt><dd class="s-mono">${e(preview.hash)}</dd></dl></div></details>`;
}
/** Why a page has no control: a transition is under way, this state cannot take the action, or this is the main Bot. */
function endRefusal(view: S14BotEnd): string | null {
  if (view.bot.id === "jit") return tr("s14.life.main_note");
  if (view.lifecycle.state === "deleted") return tr("s14.life.deleted_detail");
  if (view.action === "retire" && view.lifecycle.state === "retired") return tr("s14.life.already_retired");
  return view.lifecycle.state === "active" || view.lifecycle.state === "retired" ? null : tr("s14.life.settling_note");
}
function endPage(page: S14Page, view: S14BotEnd): string {
  const { bot, action, preview, lifecycle } = view, title = tr(k(`s14.life.${action}_title`)), back = `<p><a class="s-link-text" href="/team/${e(bot.id)}">${tr("s14.life.back")}</a></p>`;
  const refused = endRefusal(view), shellOptions = { current: "team" as const, bot, subtitle: title, live: lifecycleLive(lifecycle) };
  if (refused) return shell(page, botName(bot), `<div class="s-col">${botTabs(bot, "end")}<div class="s-stack" id="s14-live">${lifecycleStatus(bot, lifecycle)}</div>${banner("", title, refused)}${back}</div>`, shellOptions);
  const impact = lifecycle.state === "active" ? impactBlock(page, bot, view.routines) : "";
  const body = action === "retire"
    ? `${twoLists(tr("s14.life.stops"), ["s14.life.retire.stops_1", "s14.life.retire.stops_2", "s14.life.retire.stops_3", "s14.life.retire.stops_4"], tr("s14.life.stays"), ["s14.life.retire.stays_1", "s14.life.retire.stays_2", "s14.life.retire.stays_3", "s14.life.retire.stays_4"])}<p class="s-note">${tr("s14.life.retire.again")}</p>`
    : `${banner("danger", tr("s14.life.delete.lost"), tr("s14.life.delete.lost_detail"))}${reach(["s14.life.delete.does_1", "s14.life.delete.does_2", "s14.life.delete.does_3", "s14.life.delete.does_4", "s14.life.delete.does_5"], ["s14.life.delete.not_1", "s14.life.delete.not_2", "s14.life.delete.not_3", "s14.life.delete.not_4", "s14.life.delete.not_5"])}<p class="s-note">${tr("s14.life.delete.kept")}</p>`;
  const reset = `<p class="s-note">${tr("s14.life.computer_note")} <a class="s-link-text" href="${computerPath(bot)}">${tr("s14.life.computer_link")}</a></p>`;
  const command = action === "retire" ? commandForm(page.csrf, "bot.retire", bot.revision, { botId: bot.id, previewHash: preview.hash, retain: { history: true, evidence: true } }, tr("s14.life.retire.confirm")) : commandForm(page.csrf, "bot.delete", bot.revision, { botId: bot.id, previewHash: preview.hash }, tr("s14.life.delete.confirm"), "s-btn danger");
  const strip = ownerStrip(`${command}<a class="s-btn" href="/team/${e(bot.id)}">${tr("s14.destroy.cancel")}</a>`, tr(`s14.life.${action}.note`));
  return shell(page, botName(bot), `<div class="s-col">${botTabs(bot, "end")}<article class="s-slip" data-state="${action === "delete" ? "unknown" : "pending"}" aria-label="${title}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${title}</h2><p class="s-meta">${tr(`s14.life.${action}.meta`)}</p></div>${lifecyclePill(lifecycle)}</div><div class="s-slip-body">${counts(preview)}${impact}${body}${manifest(preview)}${action === "delete" ? "" : reset}</div>${strip}</article>${action === "delete" ? reset : ""}${back}</div>`, shellOptions);
}
/** Renders the capability, retire and delete surfaces. Bot and work names stay escaped data, and no button label carries one. */
export function renderLifecycleSurface(page: S14Page, view: S14LifecycleSurface): string {
  return view.kind === "bot-policy" ? policyPage(page, view) : endPage(page, view);
}
