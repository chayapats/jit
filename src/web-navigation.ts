import type { Application, Project, SearchResults } from "./application";
import type { Topic } from "./conversation";
import { dictionaries, tr } from "./i18n";
import type { TelegramStatus } from "./telegram/types";
import { escape, icon, jobStateLabels, prObservedState, prStatusLabels, shell, taskStatusText, time, type NavigationWorkspace } from "./web-layout";
import { panelRows, panelTabLabels, panelTabs, paletteCommands, searchLimits, type PanelTab } from "./web-settings";

/** One ⌘K row. `href` is always a same-origin path; labels are dictionary text or escaped-on-render owner text. */
export interface SearchItem { kind: "command" | "project" | "topic"; label: string; detail: string | null; href: string }
/** The `/api/search` body (web.settings_ia/v1). `more` means a kind had more matches than its limit. */
export interface SearchResponse { query: string; items: SearchItem[]; more: boolean }

/**
 * Turns a bounded application search into palette rows: projects, then topics, then navigation commands whose
 * Thai or English label contains the query. An empty query lists commands only. Must run inside the request's
 * locale so command labels match the page language.
 */
export function searchItems(results: SearchResults): SearchResponse {
  const needle = results.query.toLocaleLowerCase();
  const commands = paletteCommands.filter(command => !needle || [dictionaries.th[command.label], dictionaries.en[command.label]]
    .some(label => label.toLocaleLowerCase().includes(needle))).slice(0, searchLimits.commands);
  const items: SearchItem[] = [
    ...results.projects.map(project => ({ kind: "project" as const, label: project.name, detail: null, href: `/projects/${project.id}` })),
    ...results.topics.map(({ project, topic }) => ({ kind: "topic" as const, label: topic.title!, detail: project.name, href: `/projects/${project.id}/topics/${topic.id}` })),
    ...commands.map(command => ({ kind: "command" as const, label: tr(command.label), detail: null, href: command.href })),
  ];
  return { query: results.query, items, more: results.more.projects || results.more.topics };
}

/** No-script ⌘K: a GET form with server-rendered, bounded results. */
export function searchPage(response: SearchResponse, workspace: NavigationWorkspace, csrf: string): string {
  const kinds: Record<SearchItem["kind"], string> = { project: tr("search.kind_project"), topic: tr("search.kind_topic"), command: tr("search.kind_command") };
  const group = (kind: SearchItem["kind"], heading: string) => {
    const rows = response.items.filter(item => item.kind === kind);
    return rows.length ? `<section aria-labelledby="search-${kind}"><h2 class="section-heading" id="search-${kind}">${heading}</h2><ul class="search-results">${rows.map(item =>
      `<li><a href="${escape(item.href)}"><span class="search-kind">${kinds[item.kind]}</span><span class="search-label">${escape(item.label)}</span>${item.detail ? `<span class="search-detail">${escape(item.detail)}</span>` : ""}</a></li>`).join("")}</ul></section>` : "";
  };
  const found = response.items.some(item => item.kind !== "command");
  return shell(tr("search.title"), { workspace, csrf, section: "search" }, `<div class="content search-content">
    <form class="create-form search-form" method="get" action="/search" role="search"><label class="sr-only" for="search-query">${tr("search.query")}</label><input id="search-query" name="q" type="search" maxlength="${searchLimits.query}" value="${escape(response.query)}" placeholder="${tr("search.placeholder")}" autocomplete="off"><button class="primary">${tr("search.submit")}${icon("search")}</button></form>
    <p class="search-note">${tr("search.scope_note")}</p>
    ${response.query && !found ? `<p class="empty-list" role="status">${tr("search.no_results")}</p>` : ""}
    ${group("project", tr("search.projects"))}${group("topic", tr("search.topics"))}${group("command", tr("search.commands"))}
    ${response.more ? `<p role="status">${tr("search.refine")}</p>` : ""}</div>`);
}

/** Read models for one topic panel tab; only the open tab is read. */
export type PanelData =
  | { tab: "memory"; state: ReturnType<Application["memory"]> }
  | { tab: "tasks"; state: ReturnType<Application["tasks"]> }
  | { tab: "jobs"; state: ReturnType<Application["jobs"]> }
  | { tab: "pr"; state: ReturnType<Application["prReports"]> }
  | { tab: "team"; state: ReturnType<Application["team"]> };

function panelContent(project: Project, topic: Topic, data: PanelData): string {
  const base = `/projects/${project.id}`;
  const list = (rows: string[], empty: string) => rows.length ? `<ul class="panel-list">${rows.slice(0, panelRows).map(row => `<li>${row}</li>`).join("")}</ul>` : `<p class="empty-list">${empty}</p>`;
  const more = (href: string, label: string) => `<p class="panel-more"><a href="${href}">${label}</a></p>`;
  const pill = (state: string, text: string) => `<span class="job-status" data-state="${escape(state)}">${escape(text)}</span>`;
  if (data.tab === "memory") {
    const rows = data.state.items.flatMap(item => item.state === "available"
      ? [`<a href="${base}/memory/claims/${item.claim.claimId}?revision=${item.claim.revision}&amp;generation=${item.claim.generation}">${escape(Array.from(item.claim.text).slice(0, 140).join(""))}</a><small>${item.claim.kind === "explicit_fact" ? tr("panel.fact") : tr("panel.inference")}</small>`] : []);
    return `${list(rows, tr("panel.no_memory"))}${more(`${base}/memory`, tr("panel.open_memory"))}`;
  }
  if (data.tab === "tasks") {
    const mine = (tasks: typeof data.state.proposed) => tasks.filter(task => task.topicId === topic.id);
    const waiting = [...mine(data.state.proposed), ...mine(data.state.readyForReview)], accepted = mine(data.state.accepted);
    const row = (task: (typeof waiting)[number]) => `<a href="${base}/tasks/${task.id}">${escape(task.title)}</a>${pill(task.state, taskStatusText(task))}`;
    return `<h3 class="panel-heading">${tr("panel.waiting_on_you")} <span class="panel-count">${waiting.length}</span></h3>${list(waiting.map(row), tr("panel.nothing_waiting"))}
      <h3 class="panel-heading">${tr("tasks.accepted_tasks")}</h3>${list(accepted.map(row), tr("tasks.no_accepted_tasks_yet"))}
      ${more(`${base}/topics/${topic.id}#task-proposal`, tr("topic.propose_as_task"))}${more(`${base}/tasks?topic=${topic.id}`, tr("topic.view_project_tasks"))}`;
  }
  if (data.tab === "jobs") {
    const labels = jobStateLabels();
    const rows = data.state.items.map(job => `<a href="${base}/jobs/${job.id}">${escape(job.purpose)}</a>${pill(job.state, labels[job.state])}`);
    return `${list(rows, tr("jobs.no_jobs_in_this_project"))}${more(`${base}/jobs`, tr("panel.open_jobs"))}${more(`${base}/schedules`, tr("schedules.project_schedules"))}`;
  }
  if (data.tab === "pr") {
    const labels = prStatusLabels();
    const rows = data.state.items.map(report => `<a href="${base}/pr/reports/${report.id}">${escape(`PR #${report.pullNumber}`)}</a>${pill(prObservedState(report), report.stale ? tr("pr.not_current_stale") : labels[report.status] ?? report.status)}`);
    return `${data.state.pending.length ? `<p>${tr("panel.pr_pending")} ${data.state.pending.length}</p>` : ""}${list(rows, tr("panel.no_reports"))}${more(`${base}/pr/reports`, tr("panel.open_reports"))}`;
  }
  const specialists = data.state.roles.filter(role => role.kind === "specialist");
  const rows = specialists.map(role => `<span>${escape(role.name)}</span>${pill(role.enabled ? role.kind : "disabled", role.enabled ? role.effective.route ? tr("panel.route_set") : tr("team.not_set") : tr("team.disabled"))}`);
  return `${list(rows, tr("panel.no_specialists"))}${more(`${base}/team`, tr("panel.open_team"))}${more("/settings/team", tr("panel.manage_roles"))}`;
}

/**
 * Topic right panel (web.settings_ia/v1, S09-D05). This page is the no-script panel; the enhancement script loads
 * its `.panel-body` into the topic page's aside. Tabs are plain links, so every tab works without script.
 */
export function topicPanelPage(project: Project, topic: Topic, topics: Topic[], data: PanelData, workspace: NavigationWorkspace, csrf: string): string {
  const topicBase = `/projects/${project.id}/topics/${topic.id}`;
  const tabs = panelTabs.map((tab: PanelTab) => `<li><a href="${topicBase}/panel?tab=${tab}" data-panel-tab="${tab}"${tab === data.tab ? ' aria-current="page"' : ""}>${tr(panelTabLabels[tab])}</a></li>`).join("");
  return shell(tr("panel.title"), { workspace, csrf, project, topics, topic, section: "topic" }, `<div class="content panel-page">
    <section class="panel-body" aria-labelledby="topic-panel-title" data-tab="${data.tab}"><header class="panel-head"><h2 id="topic-panel-title" tabindex="-1">${tr(panelTabLabels[data.tab])}</h2>
    <a class="icon-button panel-close" href="${topicBase}" aria-label="${tr("panel.close")}" title="${tr("panel.close")}">${icon("close")}</a></header>
    <nav class="panel-tabs" aria-label="${tr("panel.sections")}"><ul>${tabs}</ul></nav>
    <div class="panel-content">${panelContent(project, topic, data)}</div></section></div>`, { breadcrumb: { title: topic.title ?? tr("common.topic_unavailable"), href: topicBase } });
}

const telegramNext = (): Record<string, string> => ({
  configure_bot_token_secret: tr("telegram.next_configure_token"), inspect_possible_missing_inputs: tr("telegram.next_inspect_gap"),
  bind_numeric_owner: tr("telegram.next_bind"), confirm_challenge_or_wait: tr("telegram.next_confirm"), inspect_failed_inbox: tr("telegram.next_failed"),
  inspect_unauthorized_events: tr("telegram.next_unauthorized"), poll_and_inspect: tr("telegram.next_ok"), inspect_binding: tr("telegram.next_inspect"),
});

/** Settings › Telegram: binding and inbox status (read only) and each project's notification requests. */
export function settingsTelegramPage(status: TelegramStatus, workspace: NavigationWorkspace, csrf: string): string {
  const states: Record<TelegramStatus["binding"]["state"], string> = { unbound: tr("telegram.unbound"), pending: tr("telegram.pending"), bound: tr("telegram.bound") };
  const yesNo = (value: boolean) => value ? tr("telegram.yes") : tr("telegram.no");
  return shell(tr("settings.telegram"), { workspace, csrf, section: "settings", settings: "telegram" }, `<div class="content settings-content">
    <section class="settings-section" aria-labelledby="telegram-title"><h2 id="telegram-title">${tr("telegram.companion")}</h2><p>${tr("telegram.note")}</p>
    <dl class="settings-facts"><dt>${tr("telegram.binding")}</dt><dd><span class="job-status" data-state="${status.binding.state === "bound" ? "accepted" : status.binding.state === "pending" ? "waiting" : "disabled"}">${states[status.binding.state]}</span></dd>
      <dt>${tr("telegram.credential")}</dt><dd>${yesNo(status.botCredentialConfigured)}</dd>
      <dt>${tr("telegram.gap")}</dt><dd>${status.poll.gapState === "none" ? tr("telegram.no_gap") : tr("telegram.possible_gap")}</dd>
      <dt>${tr("telegram.inbox")}</dt><dd>${tr("telegram.unauthorized")} ${status.unauthorizedCount} · ${tr("telegram.failed")} ${status.failedCount} · ${tr("telegram.pending_inbox")} ${status.pendingAuthorizedCount}</dd>
      <dt>${tr("telegram.next_action")}</dt><dd>${telegramNext()[status.nextAction] ?? tr("telegram.next_inspect")}</dd></dl></section>
    <section class="settings-section" aria-labelledby="notifications-title"><h2 id="notifications-title">${tr("common.notifications")}</h2><p>${tr("telegram.notifications_note")}</p>
    ${workspace.projects.length ? `<nav class="settings-links" aria-labelledby="notifications-title">${workspace.projects.map(p => `<a href="/projects/${p.id}/delivery">${icon("info")}<span>${escape(p.name)}</span></a>`).join("")}</nav>` : `<p class="empty-list">${tr("home.start_with_your_first_project")}</p>`}
    ${workspace.hasMore ? `<p><a href="/">${tr("common.view_all_projects")}</a></p>` : ""}</section></div>`, { breadcrumb: { title: tr("shell.settings"), href: "/settings" } });
}

/** Settings › Project data: each project's export and deletion pages (their URLs and commands are unchanged). */
export function settingsDataPage(workspace: NavigationWorkspace, csrf: string, offset: number, pageSize: number): string {
  return shell(tr("settings.data"), { workspace, csrf, section: "settings", settings: "data" }, `<div class="content settings-content">
    <section class="settings-section" aria-labelledby="data-title"><h2 id="data-title">${tr("settings.data")}</h2><p>${tr("settings.data_note")}</p>
    ${workspace.projects.length ? `<ul class="data-projects">${workspace.projects.map(p => `<li><h3>${escape(p.name)}</h3><p>${time(p.createdAt)}</p>
      <nav class="settings-links" aria-label="${escape(p.name)}"><a href="/projects/${p.id}/exports">${icon("arrow")}<span>${tr("exports.export_data")}</span></a><a href="/projects/${p.id}/memory/deletions">${icon("close")}<span>${tr("deletions.delete_data")}</span></a></nav></li>`).join("")}</ul>` : `<p class="empty-list">${tr("home.start_with_your_first_project")}</p>`}
    <nav class="pagination" aria-label="${tr("home.project_pages")}">${offset > 0 ? `<a href="/settings/data?offset=${Math.max(0, offset - pageSize)}">${tr("home.previous")}</a>` : ""}${workspace.hasMore ? `<a href="/settings/data?offset=${offset + pageSize}">${tr("common.next")}</a>` : ""}</nav></section></div>`, { breadcrumb: { title: tr("shell.settings"), href: "/settings" } });
}
