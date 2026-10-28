import type { Application, Project, SearchResults } from "./application";
import type { Topic } from "./conversation";
import { dictionaries, tr, type MessageKey } from "./i18n";
import type { TelegramStatus } from "./telegram/types";
import type { DispatchAllowance } from "./team/allowance";
import type { ScheduleFeed } from "./schedule-feed";
import { accessLevels, levelRank, type AccessLevel, type ProjectAccess, type RoleAccess } from "./exec/access";
import { connectionKinds, type ConnectionKind, type ConnectionView } from "./exec/connections";
import { accessBadge, escape, hiddenCommand, icon, jobStateLabels, prObservedState, prStatusLabels, shell, taskStatusText, time, type NavigationWorkspace } from "./web-layout";
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
  return shell(tr("search.title"), { workspace, csrf, section: "search" }, `<div class="content search-content">
    <form class="create-form search-form" method="get" action="/search" role="search"><label class="sr-only" for="search-query">${tr("search.query")}</label><input id="search-query" name="q" type="search" maxlength="${searchLimits.query}" value="${escape(response.query)}" placeholder="${tr("search.placeholder")}" autocomplete="off"><button class="primary">${tr("search.submit")}${icon("search")}</button></form>
    <p class="search-note">${tr("search.scope_note")}</p>
    ${response.query && !response.items.length ? `<p class="empty-list" role="status">${tr("search.no_results")}</p>` : ""}
    ${group("project", tr("search.projects"))}${group("topic", tr("search.topics"))}${group("command", tr("search.commands"))}
    ${response.more ? `<p role="status">${tr("search.refine")}</p>` : ""}</div>`);
}

/** Read models for one topic panel tab; only the open tab is read. */
export type PanelData =
  | { tab: "memory"; state: ReturnType<Application["memory"]> }
  | { tab: "tasks"; state: ReturnType<Application["topicTasks"]> }
  | { tab: "jobs"; state: ReturnType<Application["recentJobs"]> }
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
    const waiting = [...data.state.proposed, ...data.state.readyForReview], accepted = data.state.accepted;
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

/**
 * Settings › Execution access (web.access_settings/v1, S11-D02): one owner form per project. A level is the
 * project's revisioned execution permission; only the owner in Web may widen one, through the confirmation
 * page. The `roles` map holds each project's latest restrict-only overrides; the page pairs them with the
 * project's team roles (`list` rows) so every specialist limit posts its own override revision.
 */
export interface AccessProjectRow {
  project: NavigationWorkspace["projects"][number]; teamRoles: { id: string; name: string }[];
}
export function settingsAccessPage(workspace: NavigationWorkspace, list: { projects: AccessProjectRow[]; hasMore: boolean; single: boolean },
  access: ReadonlyMap<string, ProjectAccess>,
  roles: ReadonlyMap<string, RoleAccess[]>,
  csrf: string, offset: number, pageSize: number): string {
  const single = list.single;
  const levelText = (level: AccessLevel) => tr(`access.level_${level}` as MessageKey);
  const row = ({ project: p, teamRoles }: AccessProjectRow) => {
    const a = access.get(p.id);
    if (!a) return "";
    const overrides = new Map((roles.get(p.id) ?? []).map(item => [item.roleId, item]));
    // accessLevels is ordered lowest first, so a slice around the rank is the lower/higher set.
    const rank = levelRank(a.level);
    const lower = accessLevels.slice(0, rank);
    const higher = accessLevels.slice(rank + 1);
    const narrow = lower.length ? `<form class="team-form access-form" method="post" action="/settings/access/${p.id}">${hiddenCommand(csrf, a.revision)}
      <label>${tr("access.lower_to")}<select name="level" required>${lower.map(level => `<option value="${level}">${levelText(level)}</option>`).join("")}</select></label>
      <button class="primary">${tr("access.lower_to")}</button></form>` : "";
    const widen = higher.map(level => level === "full" && !a.fullAllowed
      ? `<p class="team-role-note">${tr("access.full_unavailable")}</p>`
      : `<a href="/settings/access/${p.id}/confirm?to=${level}&amp;rev=${a.revision}">${tr("access.raise_to")} ${levelText(level)}</a>`).join("");
    const roleRows = teamRoles.map(role => {
      const override = overrides.get(role.id);
      const current = override?.level ?? null;
      // Only levels at or below the project are offered; a saved higher override (kept across a
      // narrowing) stays visible as a read-only note instead of a choice that could never save.
      const rank = levelRank(a.level);
      const options: (AccessLevel | "inherit")[] = ["inherit", ...accessLevels.slice(0, rank + 1)];
      const above = current !== null && levelRank(current) > rank ? current : null;
      return `<li><form class="team-form access-form" method="post" action="/settings/access/${p.id}/roles">${hiddenCommand(csrf, override?.revision ?? 0)}
        <input type="hidden" name="roleId" value="${role.id}">
        <label>${tr("access.role_label")} · ${escape(role.name)}<select name="level" required>${options.map(option =>
          `<option value="${option}"${(option === "inherit" ? current === null : option === current) ? " selected" : ""}>${option === "inherit" ? tr("access.role_inherit") : levelText(option)}</option>`).join("")}</select></label>
        ${above ? `<p class="team-role-note">${levelText(above)} · ${tr("access.error_role_above_project")}</p>` : ""}
        <button>${tr("settings.save")}</button></form></li>`;
    }).join("");
    const halt = a.halted
      ? `<form class="team-form access-form" method="post" action="/settings/access/${p.id}/resume">${hiddenCommand(csrf, a.haltRevision)}<button class="primary">${tr("access.resume")}</button></form>`
      : `<form class="team-form access-form" method="post" action="/settings/access/${p.id}/halt">${hiddenCommand(csrf, a.haltRevision)}<button class="danger">${tr("access.stop_everything")}</button></form>`;
    return `<li class="access-row" id="access-${p.id}"><h3>${escape(p.name)}</h3><p>${accessBadge(a)}</p>
      ${narrow}${widen ? `<nav class="settings-links" aria-label="${escape(p.name)}">${widen}</nav>` : ""}
      ${roleRows ? `<ul class="access-roles">${roleRows}</ul>` : ""}
      ${halt}</li>`;
  };
  return shell(tr("settings.access"), { workspace, csrf, section: "settings", settings: "access" }, `<div class="content settings-content">
    <section class="settings-section" aria-labelledby="access-title"><h2 id="access-title">${tr("settings.access_title")}</h2><p>${tr("settings.access_note")}</p>
    ${list.projects.length ? `<ul class="data-projects">${list.projects.map(row).join("")}</ul>` : `<p class="empty-list">${tr("settings.dispatch_no_projects")}</p>`}
    <nav class="pagination" aria-label="${tr("home.project_pages")}">${single ? `<a href="/settings/access">${tr("common.view_all_projects")}</a>` : ""}${!single && offset > 0 ? `<a href="/settings/access?offset=${Math.max(0, offset - pageSize)}">${tr("home.previous")}</a>` : ""}${!single && list.hasMore ? `<a href="/settings/access?offset=${offset + pageSize}">${tr("common.next")}</a>` : ""}</nav></section></div>`, { breadcrumb: { title: tr("shell.settings"), href: "/settings" } });
}

/**
 * Widening confirmation (web.access_settings/v1, S11-D02): what the higher level allows, bound to one exact
 * revision. The form posts the token the confirmation page renders; any other token or a stale revision is
 * refused with a translated error, never by widening.
 */
export function accessConfirmPage(workspace: NavigationWorkspace, project: NavigationWorkspace["projects"][number],
  from: AccessLevel, to: AccessLevel, revision: number, token: string, csrf: string): string {
  void from;
  const explains = [1, 2, 3].map(n => tr(`access.explain_${to}_${n}` as MessageKey));
  return shell(tr("access.confirm_title"), { workspace, csrf, section: "settings", settings: "access" }, `<div class="content settings-content">
    <section class="settings-section" aria-labelledby="access-confirm-title"><h2 id="access-confirm-title">${tr("access.confirm_title")}</h2>
    <p>${escape(project.name)}</p><ul>${explains.map(line => `<li>${line}</li>`).join("")}</ul>
    <form class="team-form access-form" method="post" action="/settings/access/${project.id}">${hiddenCommand(csrf, revision)}
      <input type="hidden" name="level" value="${to}"><input type="hidden" name="confirmToken" value="${token}">
      <button class="primary">${tr("access.confirm_button")}</button><a href="/settings/access?project=${project.id}">${tr("access.cancel")}</a></form></section></div>`,
    { breadcrumb: { title: tr("shell.settings"), href: "/settings" } });
}

/**
 * Settings › Calendar feed (app.schedule_feed/v1). Plain forms, so every control works without script. `url` is the
 * freshly minted feed URL, passed only when rendering the response to the command that minted it; the page
 * otherwise never shows a URL, because the service keeps only the token's hash.
 */
export function settingsFeedPage(feed: ScheduleFeed, workspace: NavigationWorkspace, csrf: string, url: string | null = null): string {
  const state = feed.enabled ? `${tr("settings.feed_state_on")}${feed.tokenCreatedAt !== null ? ` · ${tr("settings.feed_since")} ${time(feed.tokenCreatedAt)}` : ""}` : tr("settings.feed_state_off");
  const shown = url ? `<div class="feed-url"><label for="feed-url">${tr("settings.feed_url_label")}</label><input id="feed-url" type="text" readonly value="${escape(url)}" autocomplete="off" spellcheck="false"><p>${tr("settings.feed_url_once")}</p></div>`
    : feed.enabled ? `<p>${tr("settings.feed_url_hidden")}</p>` : "";
  return shell(tr("settings.feed"), { workspace, csrf, section: "settings", settings: "feed" }, `<div class="content settings-content">
    <section class="settings-section" aria-labelledby="feed-title"><h2 id="feed-title">${tr("settings.feed_title")}</h2><p>${tr("settings.feed_note")}</p>
    <dl class="settings-facts"><dt>${tr("settings.feed")}</dt><dd><span class="job-status" data-state="${feed.enabled ? "accepted" : "disabled"}">${state}</span></dd>
      <dt>${tr("settings.feed_revision")}</dt><dd>${feed.revision}</dd></dl>
    ${shown}
    <form class="team-form feed-form" method="post" action="/settings/feed/${feed.enabled ? "rotate" : "create"}">${hiddenCommand(csrf, feed.revision)}<button class="primary">${tr("settings.feed_new_url")}</button></form>
    ${feed.enabled ? `<form class="team-form feed-form" method="post" action="/settings/feed/disable">${hiddenCommand(csrf, feed.revision)}<button class="danger">${tr("settings.feed_turn_off")}</button></form>` : ""}
    <p><small>${tr("settings.feed_rotate_note")}</small></p></section>
    <section class="settings-section" aria-labelledby="feed-purpose-title"><h2 id="feed-purpose-title">${tr("settings.feed_include_purpose")}</h2><p>${tr("settings.feed_purpose_note")}</p>
    <form class="team-form feed-form" method="post" action="/settings/feed/purpose">${hiddenCommand(csrf, feed.revision)}
      <label class="choice"><input type="checkbox" name="includePurpose"${feed.includePurpose ? " checked" : ""}>${tr("settings.feed_include_purpose")}</label>
      <button class="primary">${tr("settings.feed_save")}</button></form></section></div>`, { breadcrumb: { title: tr("shell.settings"), href: "/settings" } });
}

/** Settings › Project data: each project's export and deletion pages (their URLs and commands are unchanged). */
export function settingsDataPage(workspace: NavigationWorkspace, csrf: string, offset: number, pageSize: number): string {
  return shell(tr("settings.data"), { workspace, csrf, section: "settings", settings: "data" }, `<div class="content settings-content">
    <section class="settings-section" aria-labelledby="data-title"><h2 id="data-title">${tr("settings.data")}</h2><p>${tr("settings.data_note")}</p>
    ${workspace.projects.length ? `<ul class="data-projects">${workspace.projects.map(p => `<li><h3>${escape(p.name)}</h3><p>${time(p.createdAt)}</p>
      <nav class="settings-links" aria-label="${escape(p.name)}"><a href="/projects/${p.id}/exports">${icon("arrow")}<span>${tr("exports.export_data")}</span></a><a href="/projects/${p.id}/memory/deletions">${icon("close")}<span>${tr("deletions.delete_data")}</span></a></nav></li>`).join("")}</ul>` : `<p class="empty-list">${tr("home.start_with_your_first_project")}</p>`}
    <nav class="pagination" aria-label="${tr("home.project_pages")}">${offset > 0 ? `<a href="/settings/data?offset=${Math.max(0, offset - pageSize)}">${tr("home.previous")}</a>` : ""}${workspace.hasMore ? `<a href="/settings/data?offset=${offset + pageSize}">${tr("common.next")}</a>` : ""}</nav></section></div>`, { breadcrumb: { title: tr("shell.settings"), href: "/settings" } });
}

/**
 * Settings › Team dispatch (app.dispatch_allowance/v1): one owner form per project. The allowance is the only standing
 * authorization Jit has, it covers read-only specialist analysis only, and the operator ceiling caps it.
 */
export function settingsDispatchPage(workspace: NavigationWorkspace, list: { projects: NavigationWorkspace["projects"]; hasMore: boolean; single: boolean },
  allowances: ReadonlyMap<string, DispatchAllowance>, csrf: string, offset: number, pageSize: number): string {
  const single = list.single;
  const row = (p: NavigationWorkspace["projects"][number]) => {
    const a = allowances.get(p.id);
    if (!a) return "";
    const state = a.enabled ? `${tr("settings.dispatch_on")} ${a.effectiveMaxRoles} ${tr("settings.dispatch_people")}` : tr("settings.dispatch_off");
    return `<li class="allowance-row" id="allowance-${p.id}"><h3>${escape(p.name)}</h3><p><span class="job-status" data-state="${a.enabled ? "accepted" : "disabled"}">${state}</span></p>
      ${a.effectiveMaxRoles < a.maxRoles ? `<p>${tr("settings.dispatch_capped")} ${a.effectiveMaxRoles}</p>` : ""}
      <form class="team-form allowance-form" method="post" action="/settings/dispatch/${p.id}">${hiddenCommand(csrf, a.revision)}
        <label class="choice"><input type="checkbox" name="enabled"${a.enabled ? " checked" : ""}>${tr("settings.dispatch_enabled")}</label>
        <label>${tr("settings.dispatch_max")}<input type="number" name="maxRoles" min="1" max="${a.ceiling}" step="1" required value="${Math.min(a.maxRoles, a.ceiling)}"></label>
        <small>${tr("settings.dispatch_ceiling")} ${a.ceiling} · ${tr("settings.dispatch_revision")} ${a.revision}${a.revision === 0 ? ` (${tr("settings.dispatch_default")})` : ""}</small>
        <button class="primary">${tr("settings.dispatch_save")}</button></form></li>`;
  };
  return shell(tr("settings.dispatch"), { workspace, csrf, section: "settings", settings: "dispatch" }, `<div class="content settings-content">
    <section class="settings-section" aria-labelledby="dispatch-title"><h2 id="dispatch-title">${tr("settings.dispatch_title")}</h2><p>${tr("settings.dispatch_note")}</p>
    ${list.projects.length ? `<ul class="data-projects">${list.projects.map(row).join("")}</ul>` : `<p class="empty-list">${tr("settings.dispatch_no_projects")}</p>`}
    <nav class="pagination" aria-label="${tr("home.project_pages")}">${single ? `<a href="/settings/dispatch">${tr("common.view_all_projects")}</a>` : ""}${!single && offset > 0 ? `<a href="/settings/dispatch?offset=${Math.max(0, offset - pageSize)}">${tr("home.previous")}</a>` : ""}${!single && list.hasMore ? `<a href="/settings/dispatch?offset=${offset + pageSize}">${tr("common.next")}</a>` : ""}</nav></section></div>`, { breadcrumb: { title: tr("shell.settings"), href: "/settings" } });
}

/**
 * Settings › Connections (web.connections_settings/v1, S11-D06): the owner's credentials for approved effects
 * and MCP servers. Values are never rendered, pre-filled or shown: the create and rotate forms take a secret
 * that the page never echoes, and every row only reports whether a secret is stored. `tested` carries the
 * outcome of the test the owner just ran, from the redirect query, so the row can name its last test result.
 */
export function settingsConnectionsPage(workspace: NavigationWorkspace, list: ConnectionView[],
  projects: NavigationWorkspace["projects"], csrf: string, tested: { id: string; ok: boolean } | null = null,
  createState: { scope: string[]; error: MessageKey } | null = null): string {
  const names = new Map(projects.map(p => [p.id, p.name]));
  const kindText = (kind: ConnectionKind) => tr(`connection.kind_${kind}` as MessageKey);
  const scopeText = (scope: string[] | null) => scope === null ? tr("connection.scope_all")
    : scope.map(id => escape(names.get(id) ?? id)).join(", ");
  const checked = createState ? new Set(createState.scope) : null;
  const row = (view: ConnectionView) => {
    const lastTest = tested?.id === view.id
      ? tested.ok ? tr("connection.last_test_ok") : tr("connection.last_test_failed")
      : tr("connection.never_tested");
    // An empty connection takes its first secret here; only a filled one rotates it.
    const secretForm = view.secret === "empty"
      ? `<form class="team-form connection-form" method="post" action="/settings/connections/${view.id}/secret">${hiddenCommand(csrf, view.revision)}
        <label>${tr("connection.secret")}<input type="password" name="secret" autocomplete="off" required></label>
        <button>${tr("connection.set_secret")}</button></form>`
      : `<form class="team-form connection-form" method="post" action="/settings/connections/${view.id}/secret">${hiddenCommand(csrf, view.revision)}
        <label>${tr("connection.secret")}<input type="password" name="secret" autocomplete="off" required></label>
        <button>${tr("connection.rotate")}</button></form>`;
    return `<li class="connection-row" id="connection-${view.id}"><h3>${escape(view.label)}</h3>
      <dl class="settings-facts"><dt>${tr("connection.kind")}</dt><dd>${kindText(view.kind)}</dd>
        <dt>${tr("connection.scope")}</dt><dd>${scopeText(view.projectScope)}</dd>
        <dt>${tr("connection.created")}</dt><dd>${time(view.createdAt)}</dd>
        ${view.rotatedAt !== null ? `<dt>${tr("connection.rotated")}</dt><dd>${time(view.rotatedAt)}</dd>` : ""}
        <dt>${tr("connection.test")}</dt><dd>${lastTest}</dd></dl>
      ${secretForm}
      <form class="team-form connection-form" method="post" action="/settings/connections/${view.id}/test">${hiddenCommand(csrf, view.revision)}
        <button>${tr("connection.test")}</button></form>
      <form class="team-form connection-form" method="post" action="/settings/connections/${view.id}/remove">${hiddenCommand(csrf, view.revision)}
        <label class="choice"><input type="checkbox" name="confirm" required>${tr("connection.remove_confirm")}</label>
        <button class="danger">${tr("connection.remove")}</button></form></li>`;
  };
  return shell(tr("settings.connections"), { workspace, csrf, section: "settings", settings: "connections" }, `<div class="content settings-content">
    <section class="settings-section" aria-labelledby="connections-title"><h2 id="connections-title">${tr("connection.title")}</h2><p>${tr("connection.note")}</p>
    <form class="team-form connection-form" method="post" action="/settings/connections">${hiddenCommand(csrf, 0)}
      <label>${tr("connection.label")}<input name="label" required maxlength="80" autocomplete="off"></label>
      <label>${tr("connection.kind")}<select name="kind" required>${connectionKinds.map(kind => `<option value="${kind}">${kindText(kind)}</option>`).join("")}</select></label>
      <fieldset class="choice-group"><legend>${tr("connection.scope")}</legend>
        <p><small>${tr("connection.scope_limit")}</small></p>
        ${projects.map(p => `<label class="choice"><input type="checkbox" name="scope-${p.id}"${checked?.has(p.id) ? " checked" : ""}>${escape(p.name)}</label>`).join("")}</fieldset>
      ${createState ? `<p class="error" role="alert">${tr(createState.error)}</p>` : ""}
      <label>${tr("connection.secret")}<input type="password" name="secret" autocomplete="off" required></label>
      <button class="primary">${tr("connection.create")}</button></form></section>
    <section class="settings-section" aria-labelledby="connections-list-title"><h2 id="connections-list-title">${tr("settings.connections")}</h2>
    ${list.length ? `<ul class="data-projects">${list.map(row).join("")}</ul>` : `<p class="empty-list" role="status">${tr("connection.note")}</p>`}</section></div>`,
    { breadcrumb: { title: tr("shell.settings"), href: "/settings" } });
}
