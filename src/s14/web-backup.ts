import { tr, trMaybe } from "../i18n";
import type { OnlineBackupReceipt } from "./ops-types";
import { restorePrepareStep, s14OpsStatusCommand, s14ServeCommand, type S14OpsStage, type S14OpsStep } from "./ops-guide";
import { banner, botName, commandForm, e, k, noticeText, ownerStrip, pill, shell, short, when } from "./web-pages";
import type { S14Page } from "./web";
import type { S14BackupItem } from "./backup-inventory";
import { recoveryRoom, type S14BackupSurface } from "./web-product-backup";

/* Backup and restore (OPS14-01). Routine backup is one owner press with no terminal. Restore is offline on purpose, so this surface explains it and hands over exact commands; it holds no restore control. */
const fill = (key: string, values: Record<string, string | number>) => Object.entries(values).reduce((line, [name, value]) => line.replaceAll(`{${name}}`, () => String(value)), tr(k(key)));
const reasonText = (code: string) => trMaybe(`s14.error.${code}`) ?? tr("s14.backup.reason_generic");
const code = (value: string) => `<p class="s-mono s-meta">${e(value)}</p>`;
const bytes = (value: number | null) => value === null ? tr("s14.unknown") : value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`;
const madeAt = (item: S14BackupItem) => item.createdAt === null ? tr("s14.unknown") : when(item.createdAt);
const itemHref = (id: string, suffix = "") => `/settings/backup/${e(id)}${suffix}`;
const healthTone: Record<S14BackupItem["health"], [string, string]> = { intact: ["ok", "✓"], damaged: ["danger", "×"], unsupported: ["warn", "!"] };
const healthPill = (item: S14BackupItem) => pill(tr(k(`s14.backup.health.${item.health}`)), ...healthTone[item.health]);
const originPill = (item: S14BackupItem) => pill(tr(k(`s14.backup.origin.${item.origin}`)));
const list = (keys: string[], tag = "ul", cls = "s-backup-list") => `<${tag} class="${cls}">${keys.map(key => `<li>${tr(k(key))}</li>`).join("")}</${tag}>`;
const liveMark = (phase: string) => `<span hidden data-phase="${e(phase)}"></span>`;

/** Fixed lists from the backup contract: what the manifest covers and what never enters an archive. */
const contents = () => `<div class="s-backup-sides"><div><h3>${tr("s14.backup.inside_title")}</h3>${list(["s14.backup.inside.work", "s14.backup.inside.memory", "s14.backup.inside.team", "s14.backup.inside.sessions"])}</div><div><h3>${tr("s14.backup.outside_title")}</h3>${list(["s14.backup.outside.password", "s14.backup.outside.accounts", "s14.backup.outside.websites", "s14.backup.outside.computers"])}</div></div>`;
const reconnect = () => `<p class="s-sub">${tr("s14.backup.reconnect_note")}</p>`;

function progressCard(receipt: OnlineBackupReceipt): string {
  const { phase, completed, total } = receipt.progress, waiting = phase === "waiting_native_settlement", native = phase === "native" || waiting, finished = phase === "native" && completed >= total;
  const row = (name: string, state: "done" | "now" | "later", detail: string) => `<li data-step="${state}"><span>${tr(k(`s14.backup.step.${name}`))}</span><small>${e(detail)}</small></li>`;
  const word = (state: "done" | "now" | "later") => tr(k(`s14.life.step_word.${state}`));
  const sessions = total ? fill("s14.backup.count_of", { done: completed, total }) : word(native ? "done" : "later");
  return `<article class="s-slip" aria-labelledby="s14-backup-now"><div class="s-slip-hd"><div><h2 id="s14-backup-now">${tr("s14.backup.saving")}</h2><p class="s-meta">${tr("s14.backup.started")} ${when(receipt.startedAt)}</p></div>${pill(tr("s14.backup.state.capturing"), "strong")}</div><div class="s-slip-body">${waiting ? banner("warn", tr("s14.backup.slow_title"), tr("s14.backup.slow_detail")) : ""}
    <ol class="s-steps s-backup-progress">${row("application", phase === "application" ? "now" : "done", word(phase === "application" ? "now" : "done"))}${row("native", phase === "application" ? "later" : finished ? "done" : "now", sessions)}${row("finish", finished ? "now" : "later", word(finished ? "now" : "later"))}</ol>
    <p class="s-sub">${tr("s14.backup.paused_note")}</p><p class="s-note"><a class="s-link-text" href="/settings/backup?request=${e(receipt.requestId)}">${tr("s14.refresh")}</a></p></div></article>`;
}
function resultBanner(view: S14BackupSurface, receipt: OnlineBackupReceipt): string {
  if (receipt.state === "blocked") return banner("danger", reasonText(receipt.reason ?? "s14_backup_capture_failed"), trMaybe(`s14.next.${receipt.reason}`) ?? tr("s14.backup.failed_next"), receipt.reason ? code(receipt.reason) : "");
  const item = view.items.find(entry => entry.id === receipt.backupId);
  if (!item) return banner("", tr("s14.backup.done_title"), tr("s14.backup.rotated_note"));
  return banner("ok", tr("s14.backup.done_title"), "", `<dl class="s-kv"><dt>${tr("s14.backup.made")}</dt><dd>${madeAt(item)}</dd><dt>${tr("s14.backup.size")}</dt><dd>${bytes(item.bytes)}</dd></dl><p><a class="s-link-text" href="${itemHref(item.id)}">${tr("s14.backup.open_item")}</a></p>`);
}
/** Work, computers and sign-ins that hold a backup back, each linking to the control that settles it. Listing one here grants and stops nothing. */
function holdups(page: S14Page, view: S14BackupSurface): string[] {
  const running = page.work.filter(work => work.state === "running" || work.state === "stopping").map(work => `<li><a class="s-link-text" href="/work/${e(work.id)}">${e(work.title)}</a></li>`);
  const computers = page.state.bots.filter(bot => { const state = page.overview.computers[bot.id]?.computer?.state; return state && state !== "stopped" && state !== "deleted"; }).map(bot => `<li><a class="s-link-text" href="/team/${e(bot.id)}?tab=computer">${tr("s14.tab.computer")} · ${e(botName(bot))}</a></li>`);
  const bots = page.state.bots.filter(bot => ["stopping", "deleting"].includes(page.overview.lifecycles?.[bot.id]?.state ?? "")).map(bot => `<li><a class="s-link-text" href="/team/${e(bot.id)}">${e(botName(bot))}</a></li>`);
  const replies = page.state.replies.some(reply => reply.state === "running") ? [`<li>${tr("s14.backup.hold.reply")}</li>`] : [];
  return [...running, ...computers, ...bots, ...replies, ...(view.signIn ? [`<li><a class="s-link-text" href="/settings/provider">${tr("s14.backup.hold.sign_in")}</a></li>`] : [])];
}
function holdupBanner(page: S14Page, view: S14BackupSurface, title: string, detail: string): string {
  const rows = holdups(page, view);
  return banner("warn", title, detail, rows.length ? `<ul class="s-backup-list">${rows.join("")}</ul>` : `<p class="s-sub">${tr("s14.backup.hold.other")}</p>`);
}
function createStrip(page: S14Page, view: S14BackupSurface): string {
  const full = view.retention.count >= view.retention.limit;
  return ownerStrip(commandForm(page.csrf, "backup.create", view.revision, {}, tr("s14.backup.create"), "s-btn primary"), tr(full ? "s14.backup.create_note_full" : "s14.backup.create_note"));
}
/** The one card that follows a capture. It stays on its last result, so a failure is still here after a reload. */
function statusCard(page: S14Page, view: S14BackupSurface): string {
  const { receipt, refusal } = view;
  if (receipt?.state === "capturing") return progressCard(receipt);
  // A failed native close keeps the fence on this process, so only the exclusive start can release it.
  if (receipt?.workers === "paused") return `<article class="s-slip" data-state="unknown" aria-labelledby="s14-backup-now"><div class="s-slip-hd"><div><h2 id="s14-backup-now">${tr("s14.backup.state.blocked")}</h2></div>${pill(tr("s14.backup.state.blocked"), "danger", "×")}</div><div class="s-slip-body">${resultBanner(view, receipt)}</div></article>`;
  const quiesce = refusal === "s14_ops_quiesce_required";
  const refused = !refusal ? createStrip(page, view) : `<div class="s-slip-body">${quiesce ? holdupBanner(page, view, tr("s14.backup.hold_title"), tr("s14.backup.hold_detail")) : banner("warn", reasonText(refusal), trMaybe(`s14.next.${refusal}`) ?? "", code(refusal))}</div>`;
  const state = !receipt ? pill(tr("s14.backup.state.none")) : receipt.state === "complete" ? pill(tr("s14.backup.state.complete"), "ok", "✓") : pill(tr("s14.backup.state.blocked"), "danger", "×");
  const failed = receipt?.state === "blocked";
  return `<article class="s-slip"${failed ? ' data-state="unknown"' : ' data-state="closed"'} aria-labelledby="s14-backup-now"><div class="s-slip-hd"><div><h2 id="s14-backup-now">${tr(receipt ? "s14.backup.latest" : "s14.backup.first_title")}</h2>${receipt ? `<p class="s-meta">${tr("s14.backup.started")} ${when(receipt.startedAt)}</p>` : `<p class="s-meta">${tr("s14.backup.first_detail")}</p>`}</div>${state}</div>${receipt ? `<div class="s-slip-body">${resultBanner(view, receipt)}</div>` : ""}${refused}</article>`;
}
function backupRow(item: S14BackupItem): string {
  return `<a class="s-work-row" href="${itemHref(item.id)}"><span><span>${madeAt(item)}</span><small>${bytes(item.bytes)} · ${tr(k(`s14.backup.origin.${item.origin}`))}</small></span><span class="s-row-pills">${healthPill(item)}</span></a>`;
}
function backupList(view: S14BackupSurface): string {
  const { items, retention } = view, attention = items.filter(item => item.health !== "intact").length, newest = items.find(item => item.createdAt !== null);
  const health = items.length ? `<dl class="s-facts s-backup-health"><div><dt>${tr("s14.backup.kept")}</dt><dd><b>${items.length}</b> ${fill("s14.backup.of_limit", { limit: retention.limit })}</dd></div><div><dt>${tr("s14.backup.newest")}</dt><dd>${newest ? madeAt(newest) : tr("s14.unknown")}</dd></div><div><dt>${tr("s14.backup.needs_attention")}</dt><dd><b>${attention}</b></dd></div></dl>` : "";
  return `<section class="s-stack" id="s14-backup-list" aria-labelledby="s14-backups"><h2 class="s-section-t" id="s14-backups">${tr("s14.backup.list")}</h2>${health}${items.length ? `<div>${items.map(backupRow).join("")}</div><p class="s-note">${tr(retention.protected.length ? "s14.backup.retention_protected" : "s14.backup.retention")}</p>` : `<p class="s-sub">${tr("s14.backup.empty")}</p>`}</section>`;
}
function stageState(stage: S14OpsStage): string {
  const tone: Record<S14OpsStage["state"], [string, string]> = { preparing: ["strong", ""], validated: ["strong", ""], activating: ["warn", "!"], complete: ["ok", "✓"], partial: ["warn", "!"], blocked: ["warn", "!"], discarded: ["", ""] };
  return pill(tr(k(`s14.backup.stage.${stage.state}`)), ...tone[stage.state]);
}
const stageFacts = (stage: S14OpsStage) => `<dl class="s-kv"><dt>${tr("s14.backup.guide.stage")}</dt><dd class="s-mono">${e(stage.id)}</dd><dt>${tr("s14.backup.guide.source")}</dt><dd class="s-mono">${e(stage.backupId)}</dd><dt>${tr("s14.backup.guide.recovery")}</dt><dd class="s-mono">${e(stage.recoveryBackupId)}</dd></dl>`;
/** The last operation stays readable. A running service only ever finds a finished one: an unfinished stage keeps the store from opening. Finished is no claim about work or actions that were unknown. */
function lastOperation(stage: S14OpsStage): string {
  const links = `<p class="s-row"><a class="s-link-text" href="/recovery">${tr("s14.more.recovery")}</a><a class="s-link-text" href="/settings/provider">${tr("s14.more.provider")}</a><a class="s-link-text" href="/settings/web">${tr("s14.more.web")}</a></p>`;
  if (stage.state === "discarded") return banner("", tr(k(`s14.backup.last.discarded_${stage.mode}`)), tr("s14.backup.last.discarded_detail"));
  return banner("", tr(k(`s14.backup.last.complete_${stage.mode}`)), tr("s14.backup.last.complete_detail"), `${links}${stageFacts(stage)}`);
}
function block(step: Pick<S14OpsStep, "script">, id: string): string {
  return `<div class="s-backup-block"><pre class="s-exact" id="${id}">${e(step.script)}</pre><button type="button" class="s-btn" data-copy="${id}" data-copied="${tr("s14.signin.copied")}" hidden>${tr("s14.backup.copy")}</button></div>`;
}
function restoreCard(view: S14BackupSurface): string {
  const stage = view.stage, usable = view.items.filter(item => item.health === "intact");
  const body = usable.length ? `<p class="s-sub">${tr("s14.backup.restore_lead")}</p><p class="s-note">${tr("s14.backup.restore_pick")}</p>` : `<p class="s-sub">${tr(view.items.length ? "s14.backup.restore_none_usable" : "s14.backup.restore_none")}</p>`;
  return `<section class="s-card s-stack" id="s14-backup-restore" aria-labelledby="s14-restore"><h2 id="s14-restore">${tr("s14.backup.restore_title")}</h2>${stage ? lastOperation(stage) : ""}${body}</section>`;
}
function versionCard(view: S14BackupSurface): string {
  const { stage } = view;
  return `<section class="s-card s-stack" id="s14-backup-version" aria-labelledby="s14-version"><h2 id="s14-version">${tr("s14.backup.version_title")}</h2><dl class="s-kv"><dt>${tr("s14.backup.data_format")}</dt><dd><span class="s-mono">schema 14 · jit/0.1.0</span></dd><dt>${tr("s14.backup.upgrades")}</dt><dd>${tr("s14.backup.upgrades_detail")}</dd><dt>${tr("s14.backup.workers")}</dt><dd>${tr(k(`s14.backup.workers.${view.workers}`))}</dd><dt>${tr("s14.backup.last_operation")}</dt><dd>${stage ? `${tr(k(`s14.backup.mode.${stage.mode}`))} ${stageState(stage)}` : tr("s14.backup.last_none")}</dd></dl></section>`;
}
function overview(page: S14Page, view: S14BackupSurface): string {
  const capturing = view.receipt?.state === "capturing", held = view.refusal === "s14_ops_quiesce_required";
  const phase = capturing ? tr("s14.backup.state.capturing") : view.receipt ? tr(k(`s14.backup.state.${view.receipt.state}`)) : tr("s14.backup.state.none");
  const inside = `<details class="s-card s-more"${view.items.length ? "" : " open"}><summary>${tr("s14.backup.contents_title")}</summary><div>${contents()}${reconnect()}</div></details>`;
  return shell(page, tr("s14.backup.title"), `<div class="s-col"><p class="s-sub">${tr("s14.backup.lead")}</p><div class="s-stack" id="s14-live">${liveMark(phase)}${statusCard(page, view)}</div>${backupList(view)}${inside}${restoreCard(view)}${versionCard(view)}<p><a class="s-link-text" href="/more">${tr("s14.web.back")}</a></p></div>`, { current: "more", subtitle: tr("s14.backup.subtitle"), live: capturing || held });
}
function itemPage(page: S14Page, view: S14BackupSurface, item: S14BackupItem): string {
  const facts = `<dl class="s-kv"><dt>${tr("s14.backup.made")}</dt><dd>${madeAt(item)}</dd><dt>${tr("s14.backup.size")}</dt><dd>${bytes(item.bytes)}</dd><dt>${tr("s14.backup.origin_label")}</dt><dd>${originPill(item)}</dd><dt>${tr("s14.backup.saved_sessions")}</dt><dd>${item.sessions ?? tr("s14.unknown")}</dd><dt>${tr("s14.backup.saved_files")}</dt><dd>${item.files ?? tr("s14.unknown")}</dd><dt>${tr("s14.backup.data_format")}</dt><dd class="s-mono">${item.schema === null ? tr("s14.unknown") : `schema ${item.schema}`}</dd><dt>${tr("s14.backup.identity")}</dt><dd class="s-mono">${e(item.id)}</dd></dl>`;
  const health = item.health === "intact" ? banner("ok", tr("s14.backup.health.intact"), tr("s14.backup.health.intact_detail")) : banner(item.health === "damaged" ? "danger" : "warn", tr(k(`s14.backup.health.${item.health}`)), tr(k(`s14.backup.health.${item.health}_detail`)));
  return shell(page, tr("s14.backup.item_title"), `<div class="s-col">${health}<section class="s-card s-stack" aria-labelledby="s14-backup-facts"><h2 id="s14-backup-facts">${tr("s14.backup.facts")}</h2>${facts}</section>
    <section class="s-card s-stack" aria-labelledby="s14-backup-contents"><h2 id="s14-backup-contents">${tr("s14.backup.contents_title")}</h2>${contents()}${reconnect()}</section>
    <section class="s-card s-stack" aria-labelledby="s14-backup-where"><h2 id="s14-backup-where">${tr("s14.backup.where_title")}</h2><p class="s-sub">${tr("s14.backup.where_lead")}</p><pre class="s-exact">${e(`<JIT_S14_DATABASE>.ops/backups/${item.id}/`)}</pre><p class="s-sub">${tr("s14.backup.where_copy")}</p><p class="s-note">${tr("s14.backup.where_private")}</p></section>
    ${item.health === "intact" ? `<p><a class="s-btn" href="${itemHref(item.id, "/restore")}">${tr("s14.backup.restore_open")}</a></p>` : ""}<p><a class="s-link-text" href="/settings/backup">${tr("s14.backup.back")}</a></p></div>`, { current: "more", subtitle: tr("s14.backup.title") });
}
function restoreSteps(view: S14BackupSurface, item: S14BackupItem): string {
  const prepare = restorePrepareStep(view.maintenance, item.id);
  const entry = (id: string, title: string, body: string) => `<li><div class="s-backup-step" aria-labelledby="${id}"><h3 id="${id}">${tr(k(title))}</h3>${body}</div></li>`;
  return `<section class="s-card s-stack" aria-labelledby="s14-restore-steps"><h2 id="s14-restore-steps">${tr("s14.restore.steps_title")}</h2><p class="s-sub">${tr("s14.restore.keep_open")}</p><ol class="s-backup-run">
    ${entry("s14-step-stop", "s14.restore.step.stop", `<p class="s-sub">${tr("s14.restore.step.stop_detail")}</p>`)}
    ${entry("s14-step-run", "s14.restore.step.run", `<p class="s-sub">${tr("s14.restore.step.run_detail")}</p><p class="s-note">${tr("s14.restore.step.run_settings")}</p>${block(prepare, "s14-restore-prepare")}`)}
    ${entry("s14-step-read", "s14.restore.step.read", `<p class="s-sub">${tr("s14.restore.step.read_detail")}</p><dl class="s-kv"><dt>${tr("s14.backup.stage.validated")}</dt><dd>${tr("s14.restore.step.read_validated")}</dd><dt>${tr("s14.backup.stage.partial")} · ${tr("s14.backup.stage.blocked")}</dt><dd>${tr("s14.restore.step.read_stuck")}</dd></dl>`)}
    ${entry("s14-step-confirm", "s14.restore.step.confirm", `<p class="s-sub">${tr("s14.restore.step.confirm_detail")}</p>`)}
    ${entry("s14-step-start", "s14.restore.step.start", `<p class="s-sub">${tr("s14.restore.step.start_detail")}</p>${block({ script: s14ServeCommand }, "s14-restore-start")}`)}
  </ol></section><section class="s-card s-stack" aria-labelledby="s14-restore-halfway"><h2 id="s14-restore-halfway">${tr("s14.restore.halfway_title")}</h2><p class="s-sub">${tr("s14.restore.halfway_detail")}</p>${block({ script: s14OpsStatusCommand }, "s14-restore-status")}</section>`;
}
function restorePage(page: S14Page, view: S14BackupSurface, item: S14BackupItem): string {
  const noRoom = recoveryRoom(view) <= 0, rows = holdups(page, view);
  const body = item.health !== "intact" ? banner(item.health === "damaged" ? "danger" : "warn", tr(k(`s14.backup.health.${item.health}`)), tr(k(`s14.backup.health.${item.health}_detail`)))
    : noRoom ? banner("warn", reasonText("s14_ops_retention_full"), tr("s14.restore.no_room"))
    : `${rows.length ? holdupBanner(page, view, tr("s14.restore.settle_title"), tr("s14.restore.settle_detail")) : ""}${restoreSteps(view, item)}`;
  const plan = list(["s14.restore.plan.stop", "s14.restore.plan.recovery", "s14.restore.plan.check", "s14.restore.plan.confirm", "s14.restore.plan.start"], "ol", "s-backup-plan");
  const row = (name: string) => `<dt>${tr(k(`s14.restore.after.${name}`))}</dt><dd>${tr(k(`s14.restore.after.${name}_detail`))}</dd>`;
  return shell(page, tr("s14.restore.title"), `<div class="s-col">${banner("", tr("s14.restore.terminal_title"), tr("s14.restore.terminal_detail"))}<dl class="s-kv"><dt>${tr("s14.backup.made")}</dt><dd>${madeAt(item)}</dd><dt>${tr("s14.backup.size")}</dt><dd>${bytes(item.bytes)}</dd><dt>${tr("s14.backup.identity")}</dt><dd class="s-mono">${e(short(item.id))}</dd></dl>
    <section class="s-card s-stack" aria-labelledby="s14-restore-plan"><h2 id="s14-restore-plan">${tr("s14.restore.plan_title")}</h2>${plan}</section><section class="s-card s-stack" aria-labelledby="s14-restore-after"><h2 id="s14-restore-after">${tr("s14.restore.after_title")}</h2><dl class="s-kv">${["deleted", "newer", "accounts", "password", "work", "computers"].map(row).join("")}</dl></section>
    ${body}<p><a class="s-link-text" href="${itemHref(item.id)}">${tr("s14.restore.back")}</a></p></div>`, { current: "more", subtitle: tr("s14.backup.title") });
}
/** Renders the three backup pages. */
export function renderBackupSurface(page: S14Page, view: S14BackupSurface): string {
  if (view.screen === "item") return itemPage(page, view, view.item!);
  if (view.screen === "restore") return restorePage(page, view, view.item!);
  return overview(page, view);
}
