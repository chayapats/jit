import type { Application, Project, ProjectAttention, Workspace } from "./application";
import type { WebhookReceipt } from "./pr/webhooks";
import type { Topic } from "./conversation";
import type { JobSchedule, ScheduleOccurrence } from "./jobs/schedules";
import type { Attribution, SourceLookup, SourceReference } from "./sources";
import type { Job, JobLimits, JobPolicy } from "./jobs/types";
import { currentLocale, systemText, tr, withLocale, type Locale, type MessageKey } from "./i18n";
import { assetUrl } from "./web-assets";
import { logoLockup, logoMark } from "./web-logo";
import { colorTokens } from "./web-design";
import { effectiveAccess, type AccessLevel, type ProjectAccess } from "./exec/access";
import type { ConnectionView } from "./exec/connections";
import type { McpProposalView } from "./exec/mcp";
import type { JitReplyView } from "./team/jit-reply";
import { routesOf } from "./team/role-proposals";
import { fillText, mcpInstallProposalCard, promotionProposalCard, proposalCard, roleProposalCard, approvalCard } from "./web-proposal-card";
import type { ApprovalCard } from "./exec/approval-cards";
import type { TopicPromotionView } from "./promotion";
import type { Persona } from "./persona";
import type { LocalApiSettings } from "./local-api/settings";
import type { AttentionLevels } from "./delivery";
import type { DecisionReadModel, Discussion, ParticipationResult, RoleRoute, SpecialistResultStatus } from "./team/types";
import { citableResult } from "./team/specialist-results";
import type { DispatchCardView, TeamCardRole } from "./team/jit-dispatch";
import { panelTabLabels, panelTabs, searchLimits, settingsSections, type PanelTab, type SettingsSectionId } from "./web-settings";
import { routePicker } from "./web-route-picker";
import { noRouteModels, routeText, type RouteModels } from "./team/route-options";

/** Escapes literal untrusted content before it enters HTML text or attributes. */
export const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const paths = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3Z"/>',
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2 1.5-5A8 8 0 1 1 20 11.5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  link: '<path d="m10 13 4-4m-7 6-1 1a3 3 0 0 0 4 4l4-4m-4-8 4-4a3 3 0 0 1 4 4l-1 1"/>',
  logout: '<path d="M9 4H4v16h5m5-12 4 4-4 4m-6-4h10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>', check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
};
/** Inline stroke icon; decorative, so hidden from assistive technology. */
export const icon = (name: keyof typeof paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const brand = (height = 36) => `<a class="brand" href="/" aria-label="${tr("common.jit_all_projects")}">${logoLockup({ height, label: "Jit" })}</a>`;
const sourceUrl = (projectId: string, ref: SourceReference) => `/projects/${projectId}/sources/${ref.sourceId}?revision=${ref.revision}&generation=${ref.generation}`;
const sourceLink = (projectId: string, ref: SourceReference, label: string) => `<a class="source-link" href="${sourceUrl(projectId, ref)}">${icon("link")}${escape(label)}</a>`;
const attributionLabel = (attribution: Attribution) => attribution.kind === "owner" ? tr("common.you") : attribution.kind === "participant"
  ? `${tr("common.teammate")} ${attribution.participantId} · run ${attribution.runId}` : attribution.service === "jit-setup" ? tr("setup.greeting_label")
  : attribution.service === "jit-promotion" ? tr("promotion.link_label") : attribution.service === "jit-effects" ? tr("effects.result_label")
  : tr("common.source_registry_service");
/** app.setup/v1 greeting: fixed product text in the owner's persona, shown as Jit's (never model output). */
const setupGreeting = (attribution: Attribution) => attribution.kind === "service" && attribution.service === "jit-setup";
export function time(value: number): string {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return tr("common.unknown_time");
  const format = new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `<time datetime="${date.toISOString()}" title="${date.toISOString()}">${escape(format.format(date))} UTC</time>`;
}

/** Owner appearance choice: `system` follows `prefers-color-scheme`. */
export type ThemePreference = "system" | "dark" | "light";
let activeTheme: ThemePreference = "system";
/**
 * Renders synchronously in the given language and theme. Page renderers read both from this scope,
 * so every page, including errors and sign-in, uses the same shell and dictionaries.
 */
export function renderWith<T>(ui: { locale: Locale; theme: ThemePreference }, render: () => T): T {
  const previous = activeTheme;
  activeTheme = ui.theme;
  try { return withLocale(ui.locale, render); } finally { activeTheme = previous; }
}

/** Browser chrome colour (web.pwa/v1): the page background of the theme in use, or of each system theme. */
function themeColor(): string {
  const meta = (theme: "dark" | "light", media = "") => `<meta name="theme-color" content="${colorTokens[theme].bg}"${media ? ` media="(prefers-color-scheme: ${media})"` : ""}>`;
  return activeTheme === "system" ? `${meta("dark", "dark")}${meta("light", "light")}` : meta(activeTheme);
}
/**
 * The full HTML document around a page body: theme, language, stylesheet, icons, web app manifest, fonts and the one
 * enhancement script. `viewport-fit=cover` lets the layout pad itself with the device safe areas; zoom stays allowed.
 */
export function documentPage(title: string, content: string): string {
  const theme = activeTheme === "system" ? "" : ` data-theme="${activeTheme}"`;
  return `<!doctype html><html lang="${currentLocale()}"${theme}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="color-scheme" content="${activeTheme === "system" ? "dark light" : activeTheme}">${themeColor()}<title>${escape(title)} · Jit</title>
    <link rel="stylesheet" href="${assetUrl("app.css")}"><link rel="icon" type="image/svg+xml" href="${assetUrl("favicon.svg")}">
    <link rel="manifest" href="${assetUrl("manifest.webmanifest")}"><link rel="apple-touch-icon" href="${assetUrl("apple-touch-icon.png")}">
    <link rel="preload" href="${assetUrl("inter.woff2")}" as="font" type="font/woff2" crossorigin><link rel="preload" href="${assetUrl("noto-sans-thai.woff2")}" as="font" type="font/woff2" crossorigin>
    <script type="module" src="${assetUrl("app.js")}"></script></head><body>
    <a class="skip" href="#main-content">${tr("common.skip_to_main_content")}</a>${content}</body></html>`;
}
/** Sidebar data: the workspace page plus, when known, counts of items waiting on the owner per project. */
export type NavigationWorkspace = Workspace & { attention?: Readonly<Record<string, ProjectAttention>>; access?: ReadonlyMap<string, ProjectAccess> };
/**
 * The project's execution access badge (web.access_settings/v1, S11-D02): the level in words, never colour
 * alone, plus the stopped note while the kill switch holds. The effective level while halted reads `read`.
 */
export function accessBadge(access: ProjectAccess): string {
  const stopped = access.halted ? ` <span class="access-strike" aria-hidden="true">⊘</span> ${tr("access.halted")}` : "";
  return `<span class="access-badge" data-level="${access.level}">${tr(`access.level_${access.level}` as MessageKey)}${stopped}</span>`;
}
/** Whether the topic header offers the kill switch: a wider-than-read level, or a halted project. */
export function topicHaltAction(access: ProjectAccess | undefined): boolean {
  if (!access) return false;
  return effectiveAccess(access, null).level !== "read" || access.halted;
}
export interface Navigation {
  workspace: NavigationWorkspace; csrf: string; project?: Project; topics?: Topic[]; topic?: Topic;
  section?: "home" | "project" | "topic" | "team" | "tasks" | "jobs" | "pr" | "memory" | "search" | "settings";
  /** Current settings section when `section` is `settings` (web.settings_ia/v1). */
  settings?: SettingsSectionId;
}
/** Waiting-on-owner badge: visible words and a number, never colour alone (NFR-11). */
function attentionBadge(waiting: ProjectAttention | undefined): string {
  const total = waiting ? waiting.proposals + waiting.reviews + waiting.resumes : 0;
  if (!waiting || !total) return "";
  const detail = `${tr("shell.badge_proposals")} ${waiting.proposals} · ${tr("shell.badge_reviews")} ${waiting.reviews} · ${tr("shell.badge_resumes")} ${waiting.resumes}`;
  return `<span class="nav-badge" title="${detail}"><span aria-hidden="true">${tr("shell.badge_waiting")} ${total}</span><span class="sr-only">${tr("shell.badge_waiting_long")} ${total}: ${detail}</span></span>`;
}
/** Sidebar navigation: projects with waiting-item badges, and the selected project's topics nested under it. */
function navigation(n: Navigation): string {
  const selected = n.project, topics = n.topic ? [n.topic, ...(n.topics ?? []).filter(t => t.id !== n.topic!.id)] : n.topics ?? [];
  const here = (section: NonNullable<Navigation["section"]>) => n.section === section ? ' aria-current="page"' : "";
  const listed = n.workspace.projects.slice(0, 8);
  const projects = selected && !listed.some(p => p.id === selected.id) ? [selected, ...listed] : listed;
  const nested = (p: Project) => p.id !== selected?.id ? "" : `<ul class="nav-topics" aria-label="${tr("common.topics_in_project")}">${topics.slice(0, 12).map(t => `<li><a class="nav-link" href="/projects/${p.id}/topics/${t.id}"${t.id === n.topic?.id && n.section === "topic" ? ' aria-current="page"' : ""}>${icon("chat")}<span>${escape(t.title ?? tr("common.topic_unavailable"))}</span></a></li>`).join("")}
      <li><a class="nav-subtle" href="/projects/${p.id}#new-topic">${tr("common.new_topic")}</a></li>${topics.length > 12 ? `<li><a class="nav-subtle" href="/projects/${p.id}">${tr("common.view_all_topics")}</a></li>` : ""}</ul>`;
  return `<nav class="nav-scroll" aria-label="${tr("common.projects_and_topics")}"><p class="nav-heading">${tr("common.your_projects")}</p>
    <ul class="nav-projects">${projects.map(p => `<li class="nav-project"${p.id === selected?.id ? " data-selected" : ""}><a class="nav-link" href="/projects/${p.id}"${p.id === selected?.id && n.section === "project" ? ' aria-current="page"' : ""}>${icon("folder")}<span>${escape(p.name)}</span>${n.workspace.access?.get(p.id) ? accessBadge(n.workspace.access.get(p.id)!) : ""}${attentionBadge(n.workspace.attention?.[p.id])}</a>${nested(p)}</li>`).join("")}</ul>
    <a class="nav-subtle" href="/#new-project">${tr("common.new_project")}</a>${n.workspace.hasMore || n.workspace.projects.length > 8 ? `<a class="nav-subtle" href="/"${here("home")}>${tr("common.view_all_projects")}</a>` : ""}</nav>`;
}
function ownerMenu(csrf: string): string {
  return `<div class="owner-menu"><div class="owner-name">${tr("common.your_space")}</div>
    <form method="post" action="/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="icon-button" aria-label="${tr("common.sign_out")}" title="${tr("common.sign_out")}">${icon("logout")}</button></form></div>`;
}
/** Settings sub-navigation (web.settings_ia/v1): every installation operation is one step from any settings page. */
function settingsNavigation(current: SettingsSectionId | undefined): string {
  return `<nav class="settings-nav" aria-label="${tr("settings.sections")}"><ul>${settingsSections.map(section => `<li><a href="${section.href}"${section.id === current ? ' aria-current="page"' : ""}>${tr(section.label)}</a></li>`).join("")}</ul></nav>`;
}
const panelSection: Partial<Record<NonNullable<Navigation["section"]>, PanelTab>> = { memory: "memory", tasks: "tasks", jobs: "jobs", pr: "pr", team: "team" };
/** Full-page links for the project tools the topic panel summarizes; shown on project pages outside a topic. */
function projectTools(project: Project, section: Navigation["section"]): string {
  const href: Record<PanelTab, string> = { memory: `/projects/${project.id}/memory`, tasks: `/projects/${project.id}/tasks`, jobs: `/projects/${project.id}/jobs`, pr: `/projects/${project.id}/pr/reports`, team: `/projects/${project.id}/team` };
  const current = section ? panelSection[section] : undefined;
  return `<nav class="project-tools" aria-label="${tr("panel.project_tools")}"><ul>${panelTabs.map(tab => `<li><a href="${href[tab]}"${tab === current ? ' aria-current="page"' : ""}>${tr(panelTabLabels[tab])}</a></li>`).join("")}</ul></nav>`;
}
/**
 * ⌘K palette (web.settings_ia/v1). Without script it is never shown: the sidebar search link opens `/search`, a
 * GET form with server-rendered results. The enhancement script opens this dialog with ⌘K / Ctrl+K and asks
 * `/api/search` for bounded results; every label here comes from the dictionary.
 */
function palette(): string {
  return `<dialog class="palette" id="palette" aria-labelledby="palette-title" data-kind-command="${tr("search.kind_command")}" data-kind-project="${tr("search.kind_project")}" data-kind-topic="${tr("search.kind_topic")}"
    data-empty="${tr("search.no_results")}" data-loading="${tr("search.searching")}" data-error="${tr("search.unavailable")}" data-more="${tr("search.more_on_page")}">
    <h2 class="sr-only" id="palette-title">${tr("search.title")}</h2>
    <form class="palette-form" method="get" action="/search" role="search">${icon("search")}<label class="sr-only" for="palette-query">${tr("search.query")}</label>
    <input id="palette-query" name="q" type="search" maxlength="${searchLimits.query}" autocomplete="off" spellcheck="false" placeholder="${tr("search.placeholder")}" role="combobox" aria-expanded="false" aria-controls="palette-results" aria-autocomplete="list"></form>
    <ul class="palette-results" id="palette-results" role="listbox" aria-label="${tr("search.results")}"></ul>
    <p class="palette-status" role="status" aria-live="polite"></p>
    <p class="palette-hint"><kbd>↑</kbd><kbd>↓</kbd> ${tr("search.hint_move")} · <kbd>${tr("search.key_enter")}</kbd> ${tr("search.hint_open")} · <kbd>${tr("search.key_escape")}</kbd> ${tr("search.hint_close")}</p></dialog>`;
}
/**
 * The application shell used by every signed-in page: sidebar (new chat, search, projects → topics, settings at the
 * bottom) and the main pane. Below 680 px the sidebar becomes a drawer: CSS `:target` opens it without
 * script, and the enhancement script adds Escape, focus return and no history entry. Settings pages carry the
 * settings sub-navigation, project pages the project tools, and a topic may add its right panel after the main pane.
 */
export function shell(title: string, n: Navigation, content: string, options: { breadcrumb?: { title: string; href: string }; action?: string; composer?: string; panel?: string } = {}): string {
  const frame = n.section === "settings" ? settingsNavigation(n.settings)
    : n.project && n.section && n.section !== "topic" && n.section !== "search" ? projectTools(n.project, n.section) : "";
  return documentPage(title, `<div class="app"><aside class="sidebar" id="sidebar" aria-label="${tr("shell.sidebar")}">
    <div class="sidebar-top">${brand()}<a class="drawer-close" href="#main-content" aria-label="${tr("shell.close_menu")}">${icon("close")}</a></div>
    <a class="new-chat" href="/"${n.section === "home" ? ' aria-current="page"' : ""}>${icon("plus")}<span>${tr("shell.new_chat")}</span></a>
    <a class="nav-main nav-search" href="/search" aria-keyshortcuts="Meta+K Control+K"${n.section === "search" ? ' aria-current="page"' : ""}>${icon("search")}<span>${tr("shell.search")}</span><kbd aria-hidden="true">⌘K</kbd></a>
    ${navigation(n)}
    <div class="sidebar-foot"><a class="nav-main" href="/settings"${n.section === "settings" ? ' aria-current="page"' : ""}>${icon("settings")}<span>${tr("shell.settings")}</span></a>${ownerMenu(n.csrf)}</div></aside>
    <a class="drawer-scrim" href="#main-content" tabindex="-1" aria-hidden="true"></a>
    <main class="main-pane" id="main-content"><header class="app-header"><a class="menu-button" href="#sidebar" aria-controls="sidebar" aria-label="${tr("common.open_project_menu")}">${icon("menu")}</a>
    <div class="header-title">${options.breadcrumb ? `<a class="breadcrumb" href="${options.breadcrumb.href}">${escape(options.breadcrumb.title)}</a>` : ""}<h1>${escape(title)}</h1></div>${options.action ?? ""}</header>
    <div class="scroll-region">${frame}${content}</div>${options.composer ?? ""}</main>${options.panel ?? ""}</div>${palette()}`);
}
function literalContent(text: string): string {
  const blocks: string[] = [], buffer: string[] = []; let code = false;
  const flush = () => { if (buffer.length) blocks.push(code ? `<pre><code>${escape(buffer.join("\n"))}</code></pre>` : `<p class="literal">${escape(buffer.join("\n"))}</p>`); buffer.length = 0; };
  for (const line of text.split("\n")) {
    if ((!code && /^\x60{3}[a-zA-Z0-9_+-]{0,24}\s*$/.test(line)) || (code && /^\x60{3}\s*$/.test(line))) { flush(); code = !code; }
    else buffer.push(line);
  }
  flush(); return blocks.join("");
}
export const hiddenCommand = (csrf: string, revision: number) => `<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="requestId" value="${crypto.randomUUID()}"><input type="hidden" name="expectedRevision" value="${revision}">`;

/** Home data beyond the workspace page: who to greet, the General space, the chip's choice and what waits on the owner. */
export interface HomeView {
  /** The persona's way of addressing the owner (owner text), or empty. */
  addressAs: string;
  /** The General space project (app.general_space/v1), the chip's default; null before setup creates it. */
  general: Pick<Project, "id" | "name"> | null;
  /** Project preselected on the chip (`/?project=<id>`), when it is one of the chip's options. */
  selected: string | null;
  messageBytes: number;
  /** Projects with items waiting on the owner, with their counts (web.settings_ia/v1 attention). */
  waiting: { project: Project; attention: ProjectAttention }[];
}
/**
 * The chat-first home (S09-D05, D09): a greeting, a large composer whose project chip defaults to the General space,
 * and a quiet strip of items waiting on the owner. The composer posts `chat.start` as a plain form: the new topic and
 * its first message commit together, and Jit answers it like any message. Projects and project creation follow.
 */
export function workspacePage(state: NavigationWorkspace, csrf: string, offset: number, pageSize: number, home?: HomeView): string {
  const options = home ? [...home.general ? [home.general] : [], ...state.projects.filter(p => p.id !== home.general?.id)] : [];
  const chosen = home && options.some(p => p.id === home.selected) ? home.selected : options[0]?.id;
  const composer = !home ? "" : options.length ? `<form class="composer home-composer" id="new-chat" method="post" action="/chats">${hiddenCommand(csrf, state.revision)}
      <label class="sr-only" for="chat-text">${tr("home.composer_label")}</label><textarea id="chat-text" name="text" rows="3" maxlength="${home.messageBytes}" placeholder="${tr("home.composer_placeholder")}" required aria-describedby="home-composer-note"></textarea>
      <div class="composer-bottom"><label class="project-chip">${icon("folder")}<span class="sr-only">${tr("home.project_chip")}</span><select name="projectId" aria-label="${tr("home.project_chip")}">${options.map(p => `<option value="${p.id}"${p.id === chosen ? " selected" : ""}>${escape(p.name)}</option>`).join("")}</select></label>
      <button class="send-button" aria-label="${tr("home.send")}" title="${tr("home.send")}">${icon("arrow")}</button></div></form>
    <p class="composer-note home-note" id="home-composer-note">${tr("home.composer_note")}<span class="composer-keys"> · ${tr("topic.composer_keys")}</span></p>`
    : `<p class="empty-list">${tr("home.no_project_yet")}</p>`;
  const waiting = !home ? "" : `<section class="waiting-strip" aria-labelledby="waiting-title"><h2 class="waiting-title" id="waiting-title">${tr("home.waiting_title")}</h2>${home.waiting.length
    ? `<ul>${home.waiting.map(({ project: p, attention: a }) => `<li><a href="/projects/${p.id}/tasks">${icon("folder")}<span>${escape(p.name)}</span>${attentionBadge(a)}</a></li>`).join("")}</ul>`
    : `<p>${tr("home.nothing_waiting")}</p>`}</section>`;
  const hero = home ? `<section class="home-hero"><span class="home-mark">${logoMark({ size: 48 })}</span><h2 class="home-greeting">${tr("home.greeting")}${home.addressAs ? ` ${escape(home.addressAs)}` : ""}</h2><p>${tr("home.prompt")}</p></section>`
    : `<section class="hero"><p class="eyebrow">${tr("home.a_space_for_your_ideas")}</p><h2>${tr("home.which_project_do_you_want")}</h2><p>${tr("home.pick_up_where_you_left")}</p></section>`;
  return shell(home ? tr("home.title") : tr("common.your_projects"), { workspace: state, csrf, section: "home" }, `<div class="content${home ? " home" : ""}">${hero}${composer}${waiting}
    ${home ? `<h2 class="section-heading">${tr("home.new_project_heading")}</h2>` : ""}<form class="create-form" id="new-project" method="post" action="/projects">${hiddenCommand(csrf, state.revision)}<label class="sr-only" for="name">${tr("home.project_name")}</label><input id="name" name="name" maxlength="200" placeholder="${tr("home.name_your_new_project")}" required autocomplete="off"><button class="primary" aria-label="${tr("home.create_project")}">${tr("home.create_project")}${icon("plus")}</button></form>
    <h2 class="section-heading">${tr("common.your_projects")}</h2>${state.projects.length ? `<div class="project-grid">${state.projects.map(p => `<a class="project-card" href="/projects/${p.id}">${icon("folder")}<h2>${escape(p.name)}</h2><p>${tr("home.open_topics_and_conversations")}</p></a>`).join("")}</div>` : `<p class="empty-list">${tr("home.start_with_your_first_project")}</p>`}
    <nav class="pagination" aria-label="${tr("home.project_pages")}">${offset > 0 ? `<a href="/?offset=${Math.max(0, offset - pageSize)}">${tr("home.previous")}</a>` : ""}${state.hasMore ? `<a href="/?offset=${offset + pageSize}">${tr("common.next")}</a>` : ""}</nav></div>`);
}
/** Renders the selected project's bounded topics and revision-bound topic creation form. */
export function projectPage(state: ReturnType<Application["topics"]>, workspace: NavigationWorkspace, csrf: string, after: number): string {
  const p = state.project;
  return shell(p.name, { workspace, csrf, project: p, topics: state.items, section: "project" }, `<div class="content" data-group-id="${p.groupId}"><section class="hero"><p class="eyebrow">${tr("project.project_group")}</p><h2>${escape(p.name)}</h2>${workspace.access?.get(p.id) ? `<p>${accessBadge(workspace.access.get(p.id)!)}</p>` : ""}<p>${tr("project.split_off_a_subject_and")}</p></section>
    <form class="create-form" id="new-topic" method="post" action="/projects/${p.id}/topics">${hiddenCommand(csrf, p.revision)}<label class="sr-only" for="title">${tr("project.topic_name")}</label><input id="title" name="title" maxlength="200" placeholder="${tr("project.what_do_you_want_to")}" required><button class="primary" aria-label="${tr("project.create_topic")}">${tr("project.create_topic")}${icon("plus")}</button></form>
    <h2 class="section-heading">${tr("project.topics_in_project_group")}</h2>${state.items.length ? `<ul>${state.items.map(t => `<li class="topic-row">${icon("chat")}<div class="topic-row-main"><h3><a href="/projects/${p.id}/topics/${t.id}">${escape(t.title ?? tr("common.topic_unavailable"))}</a></h3>${time(t.createdAt)}</div>${sourceLink(p.id, t.source, tr("project.topic_origin"))}</li>`).join("")}</ul>` : `<p class="empty-list">${tr("project.no_topics_yet_start_the")}</p>`}
    <nav class="pagination" aria-label="${tr("project.topic_pages")}">${after > 0 ? `<a href="/projects/${p.id}">${tr("common.first_page")}</a>` : ""}${state.hasMore ? `<a href="/projects/${p.id}?after=${state.nextAfter}">${tr("project.next_topics")}</a>` : ""}</nav></div>`, { breadcrumb: { title: tr("common.all_projects"), href: "/" } });
}
/** Pill tone for each reply state; the label text always comes with it. */
export const replyTone: Record<JitReplyView["state"], string> = { thinking: "running", answered: "succeeded", blocked: "blocked", stopped: "stopped", failed: "failed", not_admitted: "waiting" };
/** Localised app.jit_reply/v1 state label and next action. Shared by the page and the event stream. */
export function replyLabels(view: Pick<JitReplyView, "state" | "nextAction">): { state: string; next: string | null } {
  return { state: tr(`reply.state.${view.state}` as MessageKey), next: view.nextAction ? tr(`reply.next.${view.nextAction}` as MessageKey) : null };
}
/**
 * The reply placeholder under an owner message until Jit's committed reply exists. Without script it is a
 * complete status with a refresh link and a stop form; the script only updates its text from the event stream.
 * Provisional progress is labelled as unsaved and never rendered as a message. The draft and the committed text
 * share one slot and typography, and the unsaved line becomes the saved line, so a commit does not move the card.
 * The streamed text is not a live region; one polite status line announces start, connection and finish instead.
 */
function replyStatus(view: JitReplyView, base: string, projectId: string, csrf: string): string {
  const labels = replyLabels(view), stoppable = view.state === "thinking" || view.state === "blocked";
  // The page that starts at this owner message also holds its reply card.
  const here = `${base}?after=${Math.max(0, view.messageSequence - 1)}#reply-${view.id}`;
  return `<article class="message message--jit reply-status" id="reply-${view.id}" data-reply-id="${view.id}" data-reply-state="${view.state}">
    <div class="reply-head"><span class="jit-avatar"${view.state === "thinking" ? ' data-state="thinking"' : ""} data-reply-avatar>${logoMark({ size: 20 })}</span><span class="reply-name">${tr("jit.name")}</span><span class="job-status" data-state="${replyTone[view.state]}" data-reply-label>${escape(labels.state)}</span></div>
    <div class="message-body"><p class="literal reply-progress" data-reply-progress${view.progress ? "" : " hidden"}>${escape(view.progress?.text ?? "")}</p><p class="literal reply-text" data-reply-text hidden></p><p class="reply-provisional" data-reply-provisional${view.progress ? "" : " hidden"}>${tr("reply.provisional")}</p><p class="reply-saved" data-reply-saved hidden>${icon("check")}${tr("common.saved")}</p>
    <p class="reply-connection" data-reply-connection data-reconnecting="${tr("reply.reconnecting")}" data-closed="${tr("reply.connection_closed")}" hidden>${tr("reply.reconnecting")}</p><p class="reply-next" data-reply-next${labels.next ? "" : " hidden"}>${escape(labels.next ?? "")}</p><p class="reply-proposals" data-reply-proposals hidden><a href="${here}">${tr("proposal.reply_has_proposals")}</a></p></div>
    <p class="sr-only" role="status" data-reply-announce data-answered="${tr("reply.announce_answered")}"></p><div class="reply-actions">${stoppable ? `<form method="post" action="${base}/replies/${view.id}/stop" data-reply-stop>${hiddenCommand(csrf, view.revision)}<button>${tr("reply.stop")}</button></form>` : ""}${view.jobId && view.state !== "thinking" ? `<a href="/projects/${projectId}/jobs/${view.jobId}#job-${view.jobId}">${tr("reply.view_job")}</a>` : ""}<a class="reply-refresh" href="${here}" data-reply-refresh>${tr("reply.refresh")}</a></div></article>`;
}
const roleTone: Record<string, string> = { queued: "queued", running: "running", completed: "completed", blocked: "blocked", waiting: "waiting", stopped: "stopped", skipped: "skipped", excluded: "excluded" };
const reasonKeys = new Set(["cancelled", "deadline", "lease_expired", "quota", "needs_login", "route_unavailable", "budget_exhausted", "source_unavailable", "invalid_result", "input_changed", "worker_failed"]);
const resultStatuses = new Set(["done", "partial", "blocked", "failed", "incomplete"]);
/** Localised short reason a role has no result; `result_<status>` reads as that result status; unknown codes read as "no result". */
const gapReason = (reason: string) => reason.startsWith("result_") && resultStatuses.has(reason.slice(7))
  ? tr(`team.result_status_${reason.slice(7)}` as MessageKey)
  : tr((reasonKeys.has(reason) ? `team_card.reason.${reason}` : "team_card.reason.other") as MessageKey);
/** Pill tone of each app.specialist_results/v2 status; the label text always comes with it. */
const resultTone: Record<SpecialistResultStatus, string> = { done: "succeeded", partial: "partial", blocked: "blocked", failed: "failed", incomplete: "failed" };
/** Status pill of a committed specialist result (v2, or derived from a v1 record), with its label in words. */
export function resultPill(result: ParticipationResult): string {
  return `<span class="job-status result-status" data-state="${resultTone[result.status]}" data-result-status="${result.status}">${tr(`team.result_status_${result.status}` as MessageKey)}</span>`;
}
/** The single unblock action of a blocked result, escaped: it is specialist text, shown as data. */
export function unblockLine(roleName: string | null, unblock: string | null | undefined): string {
  return unblock ? `<p class="team-role-note team-unblock" data-unblock>${roleName ? `${escape(roleName)} · ` : ""}${tr("team.unblock")}: ${escape(unblock)}</p>` : "";
}
const roleLabel = (role: TeamCardRole) => tr(`team_card.role.${role.activity === "waiting" ? "waiting" : role.state}` as MessageKey);
/**
 * app.routing_selection/v1 line on a dispatch card. A fixed rule shows only its name. A model selection shows
 * "Jit chose X because …", labelled as Jit's reasoning and not evidence; the names come from owner configuration and
 * `why` is untrusted model text, so the whole line is escaped.
 */
function selectionLine(card: DispatchCardView): string {
  const selection = card.selection;
  if (!selection || !card.roles.length) return "";
  if (selection.rule !== "model") return `<p class="team-selection" data-selection-rule="${selection.rule}">${tr(`team.selection_rule_${selection.rule}` as MessageKey)}</p>`;
  const names = card.roles.map(role => role.roleName).join(", ");
  const text = selection.why ? fillText(tr("team.selection_why"), { names, why: selection.why }) : fillText(tr("team.selection_model"), { names });
  return `<p class="team-selection" data-selection-rule="model"><span class="team-selection-label">${tr("team.selection_why_label")}</span> <span class="team-selection-why">${escape(text)}</span></p>`;
}
/** Dispatch allowance settings anchor for one project. */
export const allowanceHref = (projectId: string) => `/settings/dispatch?project=${projectId}#allowance-${projectId}`;

/**
 * app.dispatch_allowance/v1 card under the Jit reply that named specialists. A proposal that waits for the owner is a
 * shared proposal card (accept a subset, or dismiss); an admitted or accepted dispatch is the collapsible team card
 * (S09-D08) with each role's state in words, skip and stop-all through the existing discussion controls, each opinion
 * readable, and "answer now" when nothing runs. Every action is a form post, so the card works without script.
 */
function dispatchCard(card: DispatchCardView, base: string, csrf: string, topicRevision: number): string {
  const here = `${base}?after=${Math.max(0, card.anchorSequence - 1)}#dispatch-${card.id}`;
  // Plain text: the shared proposal card escapes every value.
  const dropped = [
    card.dropped.unknown ? `${tr("dispatch.dropped_unknown")} ${card.dropped.unknown}` : "",
    card.dropped.ambiguous ? `${tr("dispatch.dropped_ambiguous")} ${card.dropped.ambiguous}` : "",
    card.dropped.disabled.length ? `${tr("dispatch.dropped_disabled")}: ${card.dropped.disabled.join(", ")}` : "",
    card.dropped.coordinator ? `${tr("dispatch.dropped_coordinator")} ${card.dropped.coordinator}` : "",
    card.dropped.overCeiling ? `${tr("dispatch.dropped_ceiling")} ${card.dropped.overCeiling}` : "",
  ].filter(Boolean);
  const droppedTotal = card.dropped.unknown + card.dropped.ambiguous + card.dropped.disabled.length + card.dropped.coordinator + card.dropped.overCeiling;
  const droppedLine = dropped.length ? `<p class="team-role-note">${tr("dispatch.dropped")}: ${escape(dropped.join(" · "))}</p>` : "";
  // app.specialist_results/v2: roles Jit did not call again because they are still blocked on this request.
  const blockedLine = card.blocked.length ? `<div class="team-blocked" data-dispatch-blocked><p class="team-role-note">${tr("dispatch.held_blocked")}</p>${card.blocked.map(role => unblockLine(role.roleName, role.unblock)).join("")}</div>` : "";
  if (!card.discussion) {
    // The anchor wrapper keeps `#dispatch-<id>` stable whichever card the proposal shows.
    if (card.state === "empty") return `<div id="dispatch-${card.id}"><article class="team-card proposal-card" data-proposal-kind="dispatch" data-proposal-state="empty">
      <header><div><p class="eyebrow">${tr("dispatch.kind")}</p><h3>${tr("dispatch.state.empty")}</h3></div></header><p class="proposal-note">${tr(card.blocked.length ? "dispatch.empty_blocked_note" : "dispatch.empty_note")}</p>${droppedLine}${blockedLine}</article></div>`;
    const open = card.state === "proposed";
    const actions = open ? `<div class="proposal-actions"><form class="team-form" method="post" action="/projects/${card.projectId}/dispatch/${card.id}/accept">${hiddenCommand(csrf, card.revision)}
      <fieldset class="choice-group"><legend>${tr("dispatch.choose_roles")}</legend>${card.roles.map(role => `<label class="choice"><input type="checkbox" name="role-${role.roleId}" checked>${escape(role.roleName)}</label>`).join("")}</fieldset>
      <button class="primary">${tr("dispatch.accept")}</button></form>
      <form method="post" action="/projects/${card.projectId}/dispatch/${card.id}/dismiss">${hiddenCommand(csrf, card.revision)}<button>${tr("dispatch.dismiss")}</button></form>
      <a href="${allowanceHref(card.projectId)}">${tr("dispatch.allowance_link")}</a></div>` : "";
    return `<div id="dispatch-${card.id}">${blockedLine}${proposalCard({ id: card.id, kind: "dispatch", state: open ? "proposed" : "rejected", eyebrow: tr("dispatch.kind"), title: tr("dispatch.proposal_heading"),
      meta: card.reason ? tr(`dispatch.reason.${card.reason}` as MessageKey) : "",
      fields: [{ label: tr("team_card.title"), value: card.roles.map(role => role.roleName).join(", ") }],
      dropped: droppedTotal ? { items: dropped, total: droppedTotal } : null,
      note: open ? tr("dispatch.owner_only") : null, actions: `${selectionLine(card)}${actions}`, footer: "" })}</div>`;
  }
  const team = card.discussion, live = team.roles.filter(role => role.activity === "live").length;
  const waiting = team.roles.filter(role => role.activity === "waiting").length;
  // Blocked, failed and incomplete results never count as done.
  const done = team.roles.filter(role => role.state === "completed" && citableResult(role.result)).length;
  const summary = [live ? `${tr("team_card.working")} ${live}` : "", waiting ? `${tr("team_card.waiting")} ${waiting}` : "", `${tr("team_card.done")} ${done}/${team.roles.length}`].filter(Boolean).join(" · ");
  const answered = card.teamReply?.state === "answered";
  const origin = team.origin?.kind === "owner-accepted" ? tr("team_card.origin_owner")
    : `${tr("team_card.origin_allowance")} ${card.allowanceRevision}${card.allowanceRevision === 0 ? ` (${tr("settings.dispatch_default")})` : ""}`;
  // Skip, re-dispatch and add reuse the discussion's `team.control` (skip fences the job; include admits within the role budget).
  const controlForm = (action: "skip" | "include", role: string, label: string) => `<form method="post" action="/projects/${card.projectId}/team/discussions/${team.id}/controls">${hiddenCommand(csrf, team.revision)}
    <input type="hidden" name="action" value="${action}"><input type="hidden" name="roleId" value="${role}"><input type="hidden" name="back" value="topic"><button>${label}</button></form>`;
  const rerunnable = (role: TeamCardRole) => card.canInclude && (role.state === "skipped" || role.state === "stopped" || role.state === "excluded");
  const control = (role: TeamCardRole) => role.activity !== "settled" ? controlForm("skip", role.roleId, tr("team_card.skip"))
    : rerunnable(role) ? controlForm("include", role.roleId, tr("team_card.redispatch")) : "";
  // app.routing_selection/v1 rule `reply`: answering one opinion names its participation, so that role is called again without a model choice.
  const replyForm = (role: TeamCardRole) => `<form class="team-form team-reply-to" method="post" action="${base}/messages">${hiddenCommand(csrf, topicRevision)}
    <input type="hidden" name="replyDiscussion" value="${team.id}"><input type="hidden" name="replyRole" value="${role.roleId}">
    <label>${escape(fillText(tr("team_card.reply_label"), { name: role.roleName }))}<textarea name="text" rows="2" required></textarea></label><button>${escape(fillText(tr("team_card.reply_to"), { name: role.roleName }))}</button></form>`;
  const opinion = (role: TeamCardRole) => !role.opinion ? "" : role.opinion.text === null ? `<p class="team-role-note">${tr("team_card.opinion_unavailable")}</p>`
    : `<details class="team-opinion"><summary>${tr("team_card.read_opinion")}</summary><div class="message-body">${literalContent(role.opinion.text)}</div>${card.readOnly ? "" : replyForm(role)}</details>`;
  const add = card.addable.length ? `<form class="team-form team-add" method="post" action="/projects/${card.projectId}/team/discussions/${team.id}/controls">${hiddenCommand(csrf, team.revision)}
    <input type="hidden" name="action" value="include"><input type="hidden" name="back" value="topic"><label>${tr("team_card.add_role")}<select name="roleId">${card.addable.map(role => `<option value="${role.roleId}">${escape(role.roleName)}</option>`).join("")}</select></label><button>${tr("team_card.add")}</button></form>` : "";
  const rows = team.roles.map(role => `<li class="team-role" data-role-state="${role.activity === "waiting" ? "waiting" : role.state}"><div class="team-role-head"><span class="team-role-name">${escape(role.roleName)}</span>
    <span class="job-status" data-state="${roleTone[role.activity === "waiting" ? "waiting" : role.state] ?? "waiting"}">${roleLabel(role)}</span>${role.result ? resultPill(role.result) : ""}${control(role)}</div>
    ${role.result?.status === "blocked" ? unblockLine(null, role.result.unblock) : ""}${role.activity === "waiting" ? `<p class="team-role-note">${tr("team_card.waiting_note")} <a href="/projects/${card.projectId}/jobs/${role.jobId}#job-${role.jobId}">${tr("reply.view_job")}</a></p>` : ""}${opinion(role)}</li>`).join("");
  const actions = [
    add,
    card.canStopAll ? `<form method="post" action="/projects/${card.projectId}/team/discussions/${team.id}/stop-all">${hiddenCommand(csrf, team.revision)}<button>${tr("team_card.stop_all")}</button></form>` : "",
    card.canAnswer ? `<form method="post" action="/projects/${card.projectId}/dispatch/${card.id}/answer">${hiddenCommand(csrf, card.revision)}<button>${tr("team_card.answer_now")}</button></form>` : "",
    `<a class="reply-refresh" href="${here}">${tr("reply.refresh")}</a>`,
    `<a href="/projects/${card.projectId}/team/discussions/${team.id}">${tr("team_card.view_discussion")}</a>`,
  ].join("");
  const notes = [
    team.stoppedAll ? `<p class="team-role-note">${tr("team_card.stopped_all")}</p>` : "",
    card.teamHold && !card.teamReply ? `<p class="team-role-note" role="status">${tr(`team_card.hold.${card.teamHold}` as MessageKey)}</p>` : "",
    !card.teamReply && !live && !waiting && !done ? `<p class="team-role-note">${tr("team_card.no_results")}</p>` : "",
  ].join("");
  return `<details class="team-card team-run" id="dispatch-${card.id}" data-dispatch-id="${card.id}"${answered ? "" : " open"}>
    <summary><span class="team-run-title">${tr("team_card.title")} · ${team.roles.length} ${tr("team_card.people")}</span><span class="job-status" data-state="${live ? "running" : waiting ? "waiting" : "completed"}">${summary}</span></summary>
    <p class="team-run-origin">${origin} · <a href="${allowanceHref(card.projectId)}">${tr("dispatch.allowance_link")}</a></p>${selectionLine(card)}${droppedLine}${blockedLine}
    <ul class="team-roles">${rows}</ul>${notes}<div class="reply-actions">${actions}</div></details>`;
}

/**
 * Under a committed team reply: the specialist result revisions it cites, its coverage gap, and the existing decision
 * path (ADR 0015). The save-as-decision form starts the owner's `decision.synthesize` for the discussion; the owner still
 * accepts the exact proposal revision. Nothing here records a decision.
 */
function teamReplyMeta(view: JitReplyView, card: DispatchCardView | undefined, projectId: string, csrf: string, limits: JobLimits | undefined): string {
  const team = view.team!;
  const cites = team.citations.map(item => `${sourceLink(projectId, item.reference, `${item.roleName} · r${item.reference.revision}`)}`).join(" ");
  const gap = team.gaps.length ? `${tr("team_reply.gap")}: ${team.gaps.map(item => `${escape(item.roleName)} (${gapReason(item.reason)})`).join(", ")}` : tr("team_reply.no_gap");
  const decision = card?.decision, discussion = card?.discussion;
  let action = "";
  if (decision && discussion) {
    if (decision.decided) action = `<p class="team-role-note">${tr("team_reply.decided")} · <a href="/projects/${projectId}/team/discussions/${discussion.id}#owner-decision">${tr("team_card.view_discussion")}</a></p>`;
    else if (decision.synthesis === "queued" || decision.synthesis === "running") action = `<p class="team-role-note">${tr("team_reply.decision_drafting")} <a href="/projects/${projectId}/team/discussions/${discussion.id}#owner-decision">${tr("reply.refresh")}</a></p>`;
    else if (decision.proposalId) action = `<a href="/projects/${projectId}/team/discussions/${discussion.id}#owner-decision">${tr("team_reply.review_decision")}</a>`;
    else if (limits) action = `<form method="post" action="/projects/${projectId}/team/discussions/${discussion.id}/synthesis">${hiddenCommand(csrf, discussion.revision)}
      <input type="hidden" name="limits" value="${escape(JSON.stringify(limits))}"><button>${tr("team_reply.save_decision")}</button></form><small>${tr("team_reply.save_decision_note")}</small>`;
  }
  const unblocks = team.gaps.map(item => unblockLine(item.roleName, item.unblock)).join("");
  return `<div class="team-reply-meta" data-team-reply="${view.id}"><p>${tr("team_reply.cites")}: ${cites}</p><p>${gap}</p>${unblocks}${action ? `<div class="reply-actions">${action}</div>` : ""}</div>`;
}

/**
 * Topic right panel toggle (web.settings_ia/v1). The panel is closed by default. Without script the link opens the
 * panel as its own page; the enhancement script loads that page's `.panel-body` into the empty aside instead.
 */
function panelToggle(topicBase: string): string {
  return `<a class="header-action panel-toggle" href="${topicBase}/panel" aria-controls="topic-panel" aria-expanded="false" aria-label="${tr("panel.open")}">${icon("panel")}${tr("panel.title")}</a>`;
}
const topicPanelSlot = () => `<aside class="topic-panel" id="topic-panel" aria-label="${tr("panel.title")}" hidden></aside>`;
/** Presents committed attributed messages separately from a persistent, revision-bound composer. */
export function conversationPage(state: ReturnType<Application["conversation"]>, workspace: NavigationWorkspace, topics: Topic[], csrf: string, after: number, messageBytes: number, dispatch?: {
  team: ReturnType<Application["team"]>; discussions: Discussion[]; limits: JobPolicy["maximum"]; dispatchAvailable: boolean; decision?: DecisionReadModel;
  /** app.jit_reply/v1 views keyed by owner message id. */
  replies?: Map<string, JitReplyView>;
  /** app.dispatch_allowance/v1 cards keyed by the dispatching Jit reply message id. */
  cards?: Map<string, DispatchCardView>;
  /** Limits for "save as a decision" (decision.synthesize). */
  synthesisLimits?: JobLimits;
  /** app.topic_promotion/v1: whether this topic was promoted, or continues a promoted General topic. */
  promotion?: TopicPromotionView;
  /** web.approval_cards/v1: approval cards of this topic, in thread order (EXE09). */
  approvals?: ApprovalCard[];
  /** app.mcp_servers/v1: install proposal cards of this topic, in thread order (EXE13). */
  mcp?: { proposals: McpProposalView[]; connections: ConnectionView[] };
  /** web.box_live/v1: the box runs the browser image, so the header links the live view (EXE15). */
  boxLive?: boolean;
}): string {
  const { project, topic } = state, title = topic.title ?? tr("common.topic_unavailable"), base = `/projects/${project.id}/topics/${topic.id}`;
  const replies = dispatch?.replies ?? new Map<string, JitReplyView>();
  const cards = dispatch?.cards ?? new Map<string, DispatchCardView>();
  const cardsById = new Map([...cards.values()].map(card => [card.id, card]));
  // Specialist messages of a dispatched team are shown inside its team card, not as separate chat bubbles (S09-D08).
  // Only when that card is on this page: otherwise the message stays in the column, so no page loses a result.
  const onPageCards = [...cards.values()].filter(card => card.discussion && state.items.some(item => item.id === card.replyMessageId));
  const folded = new Set(onPageCards.flatMap(card => card.discussion!.roles.map(role => role.runId)));
  const committedReplies = new Map([...replies.values()].filter(view => view.replyMessageId).map(view => [view.replyMessageId!, view]));
  const live = [...replies.values()].filter(view => view.state === "thinking" || view.state === "blocked");
  const onPage = new Set(state.items.map(item => item.id));
  // An answer committed beyond this page: link to it instead of dropping the reply from view.
  const answeredElsewhere = (view: JitReplyView) => `<article class="message message--jit reply-status" id="reply-${view.id}" data-reply-id="${view.id}" data-reply-state="answered">
    <div class="reply-head"><span class="jit-avatar">${logoMark({ size: 20 })}</span><span class="reply-name">${tr("jit.name")}</span><span class="job-status" data-state="${replyTone.answered}">${escape(replyLabels(view).state)}</span></div>
    <div class="reply-actions"><a href="${base}?after=${Math.max(0, (view.replySequence ?? 1) - 1)}#message-${view.replyMessageId}">${tr("reply.view_answer")}</a></div></article>`;
  const cursor = Math.max(0, ...[...replies.values()].map(view => view.cursor));
  const label = (m: (typeof state.items)[number]) => {
    const reply = committedReplies.get(m.id);
    return reply ? `${tr("jit.name")}${reply.team ? ` · ${tr("team_reply.label")}` : ""}${reply.mode === "fixture" ? ` · ${tr("reply.fixture")}` : ""}` : attributionLabel(m.attribution);
  };
  const roles = dispatch?.team.roles.filter(role => role.kind === "specialist" && role.enabled && role.effective.route) ?? [];
  // app.role_proposals/v1 cards follow the Jit reply that carries them; the edit form lists configured routes only.
  const routes = dispatch ? routesOf(dispatch.team) : [];
  const proposals = (view: JitReplyView | undefined) => (view?.roleProposals.map(item => roleProposalCard(item, { topicBase: base, csrf, routes, defaultRoute: dispatch?.team.projectDefault ?? dispatch?.team.ownerDefault ?? null })).join("") ?? "") +
    (view?.promotionProposals.map(item => promotionProposalCard(item, { topicBase: base, csrf, originTitle: topic.title })).join("") ?? "");
  // app.mcp_servers/v1 (EXE13): install proposal cards follow the Jit reply that carries them, in thread order
  // like role proposals, with the project-scoped connection selects. A card whose reply fell off this page is
  // not shown, the same as a role proposal card.
  const mcpByReply = new Map<string, McpProposalView[]>();
  for (const proposal of [...(dispatch?.mcp?.proposals ?? [])].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    if (proposal.topicId !== topic.id) continue;
    const list = mcpByReply.get(proposal.replyId) ?? [];
    list.push(proposal);
    mcpByReply.set(proposal.replyId, list);
  }
  const mcpCards = (view: JitReplyView | undefined) => (view && dispatch?.mcp
    ? (mcpByReply.get(view.id) ?? []).map(item => mcpInstallProposalCard(item, { topicBase: base, csrf, connections: dispatch.mcp!.connections })).join("") : "");
  // app.topic_promotion/v1: a promoted origin is read-only and points to its continuation.
  const promotedTo = dispatch?.promotion?.promotedTo ?? null, continuedFrom = dispatch?.promotion?.continuedFrom ?? null;
  const continuation = promotedTo ? `/projects/${promotedTo.target.projectId}/topics/${promotedTo.target.topicId}` : "";
  const promotedBanner = promotedTo ? `<section class="promotion-banner" id="promoted" role="note"><p><strong>${tr("promotion.promoted_title")}</strong> ${escape(fillText(tr("promotion.promoted_body"), { project: promotedTo.project.name }))}</p>
    <a class="promotion-link" href="${continuation}">${tr("promotion.continue_here")}</a></section>` : "";
  const continuedBlock = (m: (typeof state.items)[number]) => {
    if (!continuedFrom || continuedFrom.link.messageId !== m.id) return `<article id="message-${m.id}" class="message continued-from" data-message-id="${m.id}"><p class="literal">${tr("promotion.origin_unavailable")}</p></article>`;
    const origin = continuedFrom.origin;
    return `<section id="message-${m.id}" class="continued-from" data-message-id="${m.id}" data-promotion-id="${continuedFrom.id}"><details open><summary>${escape(fillText(tr("promotion.continued_from"), { project: origin.project.name }))} · ${escape(origin.topicTitle ?? tr("common.topic_unavailable"))}</summary>
      <p class="continued-meta">${escape(fillText(tr("promotion.linked_at"), { revision: String(origin.topicRevision), count: String(origin.messageSequence) }))} · ${time(continuedFrom.createdAt)}</p>
      <ol class="continued-messages">${origin.messages.map(item => `<li class="continued-message${item.attribution.kind === "owner" ? " continued-message--owner" : ""}"><span class="continued-speaker">${item.attribution.kind === "owner" ? tr("common.you") : item.jit ? tr("jit.name") : escape(attributionLabel(item.attribution))}</span><div class="message-body">${item.text === null ? `<p class="literal">${tr("common.source_unavailable")}</p>` : literalContent(item.text)}</div></li>`).join("")}</ol>
      ${origin.hasMore ? `<p class="continued-meta">${tr("promotion.more_in_origin")}</p>` : ""}<a href="/projects/${origin.projectId}/topics/${origin.topicId}">${tr("promotion.open_origin")}</a></details></section>`;
  };
  const dispatchPanel = dispatch && !promotedTo ? `<details class="team-card" id="team-dispatch"><summary>${tr("topic.ask_the_team_to_analyze")}</summary>
    ${dispatch.dispatchAvailable && roles.length ? `<form class="team-form" method="post" action="/projects/${project.id}/team/discussions">${hiddenCommand(csrf, project.revision)}
      <input type="hidden" name="topicId" value="${topic.id}"><input type="hidden" name="sources" value="${escape(JSON.stringify(topic.availability === "available" ? [topic.source] : []))}">
      <input type="hidden" name="include" value="[]"><input type="hidden" name="exclude" value="[]"><input type="hidden" name="limits" value="${escape(JSON.stringify(dispatch.limits))}">
      <label>${tr("topic.what_should_the_team_analyze")}<input name="purpose" required maxlength="300" value="${escape(title)}"></label>
      <p>${tr("topic.router_picks_only_enabled_specialists")}</p><button class="primary">${tr("topic.start_separate_analysis")}</button></form>` : `<p>${tr("topic.set_up_an_enabled_specialist")}</p>`}
    ${dispatch.discussions.length ? `<ul>${dispatch.discussions.map(item => `<li><a href="/projects/${project.id}/team/discussions/${item.id}">${escape(item.purpose)}</a> · ${item.participations.filter(p => p.state === "completed" && citableResult(p.result)).length}/${item.participations.length} ${tr("topic.done_gaps")} ${item.coverageGap.length}</li>`).join("")}</ul>` : ""}</details>` : "";
  const decision = dispatch?.decision ? decisionPanel({ projectId: project.id, topicId: topic.id, topicRevision: topic.revision, csrf, model: dispatch.decision }) : "";
  const proposeTask = `<details class="team-card" id="task-proposal"><summary>${tr("topic.propose_as_task")}</summary><form class="team-form" method="post" action="/projects/${project.id}/tasks">${hiddenCommand(csrf, topic.revision)}<input type="hidden" name="topicId" value="${topic.id}"><label>${tr("common.task_title")}<input name="title" required maxlength="200"></label><label>${tr("common.summary")}<textarea name="summary" required maxlength="${messageBytes}"></textarea></label><button class="primary">${tr("common.save_as_proposal")}</button><small>${tr("topic.conversation_messages_are_not_accepted")}</small></form><p><a href="/projects/${project.id}/tasks?topic=${topic.id}">${tr("topic.view_project_tasks")}</a></p></details>`;
  const access = workspace.access?.get(project.id);
  const haltForm = access && topicHaltAction(access)
    ? `<form class="header-halt" method="post" action="/settings/access/${project.id}/halt">${hiddenCommand(csrf, access.haltRevision)}<button class="danger">${tr("access.stop_everything")}</button></form>` : "";
  const approvals = [...(dispatch?.approvals ?? [])].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(card => approvalCard(card, { topicBase: base, csrf })).join("");
  return shell(title, { workspace, csrf, project, topics, topic, section: "topic" }, `<div class="content chat-content"${live.length ? ` data-reply-stream="${base}/events" data-reply-cursor="${cursor}"` : ""}>${promotedBanner}${dispatchPanel}${decision}${proposeTask}${approvals}<section aria-label="${tr("topic.message_history")}">${state.items.length ? state.items.map(m => { const jit = committedReplies.get(m.id), reply = replies.get(m.id), card = cards.get(m.id);
      if (m.attribution.kind === "participant" && !jit && folded.has(m.attribution.runId)) return "";
      if (m.attribution.kind === "service" && m.attribution.service === "jit-promotion") return continuedBlock(m);
      return `<article id="message-${m.id}" class="message${m.attribution.kind === "owner" ? " message--owner" : jit || setupGreeting(m.attribution) ? " message--jit" : ""}" data-message-id="${m.id}">${jit || setupGreeting(m.attribution) ? `<div class="reply-head"><span class="jit-avatar">${logoMark({ size: 20 })}</span><span class="reply-name">${tr("jit.name")}</span></div>` : ""}<div class="message-body">${m.text === null ? `<p class="literal">${tr("common.source_unavailable")}</p>` : literalContent(m.text)}</div>
      <div class="message-meta"><span>${escape(label(m))}</span><span class="committed">${icon("check")}${tr("common.saved")}</span><details><summary aria-label="${tr("topic.message_details_and_origin")}">${icon("info")}${tr("topic.details")}</summary><div class="message-detail">${time(m.committedAt)}<br>${sourceLink(project.id, m.source, tr("common.message_origin"))}${jit?.discardedTotal ? `<br>${tr("reply.discarded")}: ${jit.discardedTotal} · ${escape(jit.discarded.join(", "))}` : ""}</div></details></div>${jit?.team ? teamReplyMeta(jit, cardsById.get(jit.team.proposalId), project.id, csrf, dispatch?.synthesisLimits) : ""}</article>${proposals(jit)}${mcpCards(jit)}${card ? dispatchCard(card, base, csrf, topic.revision) : ""}${reply && (m.attribution.kind === "owner" || reply.team) ? reply.state !== "answered" ? replyStatus(reply, base, project.id, csrf) : !onPage.has(reply.replyMessageId!) ? answeredElsewhere(reply) : "" : ""}`; }).join("") : `<div class="empty-chat"><div>${icon("chat")}<h2>${tr("topic.start_this_conversation")}</h2><p>${tr("topic.keep_ideas_questions_and_things")}</p></div></div>`}</section>
      <nav class="pagination" aria-label="${tr("topic.message_history_pages")}">${after > 0 ? `<a href="${base}">${tr("common.first_page")}</a>` : ""}${state.hasMore ? `<a href="${base}?after=${state.nextAfter}">${tr("topic.next_messages")}</a>` : ""}</nav></div>`, {
    breadcrumb: { title: project.name, href: `/projects/${project.id}` }, action: `<a class="header-action" href="/projects/${project.id}#new-topic" aria-label="${tr("common.new_topic")}">${icon("plus")}${tr("common.new_topic")}</a>${panelToggle(base)}${dispatch?.boxLive ? `<a class="header-action" href="/projects/${project.id}/box/live">${tr("live.open")}</a>` : ""}${access ? accessBadge(access) : ""}${haltForm}`,
    panel: topicPanelSlot(),
    composer: promotedTo ? `<div class="composer-wrap"><div class="composer composer--closed" role="note"><p>${tr("promotion.read_only")}</p><a class="promotion-link" href="${continuation}">${tr("promotion.continue_here")}</a></div></div>`
      : `<div class="composer-wrap"><form class="composer" method="post" action="${base}/messages">${hiddenCommand(csrf, topic.revision)}<label class="sr-only" for="text">${tr("topic.your_message")}</label><textarea id="text" name="text" rows="2" maxlength="${messageBytes}" placeholder="${tr("topic.write_a_message_in_this")}" required aria-describedby="composer-note"></textarea><div class="composer-bottom"><span class="composer-topic">${icon("chat")} ${escape(title)}</span><button class="send-button" aria-label="${tr("topic.send_message")}" title="${tr("topic.send_message")}">${icon("arrow")}</button></div></form><p class="composer-note" id="composer-note">${tr("topic.jit_replies_note")}<span class="composer-keys"> · ${tr("topic.composer_keys")}</span></p></div>`,
  });
}
/**
 * The live view of the project box (web.box_live/v1, EXE15, ADR 0039): the latest screenshot, the takeover
 * state and the Start/End takeover buttons. Everything works without script: while a takeover is active the
 * screenshot is an `<input type="image">` posting click coordinates, a text form posts typed text and key
 * buttons post special keys. The local script only refreshes the image (see `data-live-refresh` in app.js).
 */
export interface BoxLiveView {
  screenshotId: string | null;
  // The merged EXE14 `TakeoverView` fields the forms post: the revision and the active takeover id. (The EXE15
  // issue names only `active` and `startedAt`; without these the forms could not name the takeover they act on.)
  takeover: { active: boolean; startedAt: number | null; revision: number; takeoverId: string | null };
  level: AccessLevel;
}
export function boxLivePage(workspace: NavigationWorkspace, project: Project, view: BoxLiveView, csrf: string): string {
  const base = `/projects/${project.id}/box`, live = `${base}/live`;
  const shot = (id: string) => `${base}/screenshot/${id}`;
  // The Refresh link reloads the stored image; the Refresh screen form captures a fresh one first (script-free).
  const refresh = `<p><a href="${live}">${tr("live.refresh")}</a></p>`
    + `<form method="post" action="${base}/refresh">${hiddenCommand(csrf, view.takeover.revision)}<button>${tr("live.refresh_screen")}</button></form>`;
  const hiddenTakeover = view.takeover.takeoverId !== null ? `<input type="hidden" name="takeoverId" value="${view.takeover.takeoverId}">` : "";
  const image = view.screenshotId
    ? view.takeover.active
      ? `<form method="post" action="${base}/takeover/click">${hiddenCommand(csrf, view.takeover.revision)}${hiddenTakeover}<input type="image" name="shot" src="${shot(view.screenshotId)}" alt="${tr("live.alt")}" width="1280" height="800" data-live-refresh data-live-latest="${base}/latest"></form>`
      : `<img src="${shot(view.screenshotId)}" alt="${tr("live.alt")}" width="1280" height="800" data-live-refresh data-live-latest="${base}/latest">`
    : `<p class="empty-list" role="status">${tr("live.no_screenshot")}</p>`;
  const takeover = view.takeover.active
    ? `<p role="status">${tr("live.takeover_active")}</p>`
      + `<form class="team-form" method="post" action="${base}/takeover/type">${hiddenCommand(csrf, view.takeover.revision)}${hiddenTakeover}<label>${tr("live.type")}<input name="text" maxlength="2000" required autocomplete="off"></label><button class="primary">${tr("live.send")}</button></form>`
      + `<form method="post" action="${base}/takeover/key">${hiddenCommand(csrf, view.takeover.revision)}${hiddenTakeover}`
      + ([["Enter", "live.key_enter"], ["Tab", "live.key_tab"], ["Escape", "live.key_escape"], ["Backspace", "live.key_backspace"],
        ["ArrowUp", "live.key_up"], ["ArrowDown", "live.key_down"], ["ArrowLeft", "live.key_left"], ["ArrowRight", "live.key_right"]] as const)
        .map(([value, label]) => `<button type="submit" name="key" value="${value}">${tr(label)}</button>`).join("") + `</form>`
      + `<form method="post" action="${base}/takeover/end">${hiddenCommand(csrf, view.takeover.revision)}${hiddenTakeover}<button class="danger">${tr("live.takeover_end")}</button></form>`
    : (view.screenshotId ? `<form method="post" action="${base}/takeover/start">${hiddenCommand(csrf, view.takeover.revision)}<button class="primary">${tr("live.takeover_start")}</button></form>` : "");
  return shell(tr("live.title"), { workspace, csrf, project, section: "project" }, `<div class="content live-content">
    <section aria-labelledby="live-title"><h2 id="live-title">${tr("live.title")}</h2>${image}${refresh}${takeover}</section></div>`,
    { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}
/** Shows exact committed source content with scope/version metadata available for inspection. */
export function sourcePage(source: SourceLookup, suppressed: boolean, project: Project, workspace: Workspace, csrf: string): string {
  return shell(tr("source.source"), { workspace, csrf, project }, `<div class="content source-content"><h1>${tr("source.cited_source")}</h1>${suppressed ? `<p role="note"><strong>${tr("source.this_source_has_been_removed")}</strong> ${tr("source.you_can_still_open_it")}</p>` : ""}${source.state === "available" ? `<p class="source-byline">${escape(attributionLabel(source.attribution))} · ${time(source.committedAt)} ${tr("source.saved")}</p>${literalContent(source.text)}` : `<p class="error">${tr("common.source_unavailable_2")}${escape(source.reason)})</p>${source.descriptor ? `<pre>${escape(JSON.stringify(source.descriptor, null, 2))}</pre>` : ""}`}
    <details class="source-details"><summary>${tr("source.source_details")}</summary><dl><dt>${tr("source.project")}</dt><dd>${escape(project.name)} · ${escape(source.projectId)}</dd><dt>${tr("label.source_id")}</dt><dd>${escape(source.reference.sourceId)}</dd><dt>${tr("label.revision_generation")}</dt><dd>${source.reference.revision} / ${source.reference.generation}</dd></dl></details></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}
/** Words for each job state; status is never shown by colour alone. */
export const jobStateLabels = (): Record<Job["state"], string> => ({ queued: tr("common.queued"), admitted: tr("jobs.running"), waiting: tr("jobs.awaiting_resume"), succeeded: tr("jobs.completed"), blocked: tr("common.hit_a_limit"), partial: tr("jobs.partially_completed"), failed: tr("jobs.unsuccessful") });
/** Presents explicit job starts, committed states, unchanged routes and finite remaining budgets. */
export function jobsPage(state: ReturnType<Application["jobs"]>, workspace: Workspace, csrf: string, after: number, policy: JobPolicy, showStart = true): string {
  const { project } = state, base = `/projects/${project.id}/jobs`;
  const labels = jobStateLabels();
  const reasons: Record<Job["reason"], string> = {
    cancelled: tr("jobs.cancelled_result_writing_closed"), revoked: tr("jobs.authorization_revoked"), superseded: tr("common.superseded"), source_retired: tr("jobs.source_retired"), context_retired: tr("jobs.context_retired"), lease_expired: tr("jobs.worker_authorization_expired"), queued: tr("jobs.waiting_for_queue_capacity"), running: tr("jobs.running_authorized_work"), complete: tr("jobs.evidence_recorded"), yielded: tr("jobs.paused_at_a_safe_point"),
    quota: tr("jobs.selected_route_is_still_over"), needs_login: tr("jobs.selected_route_requires_sign_in"), route_unavailable: tr("jobs.selected_route_isnt_ready_yet"), budget_exhausted: tr("jobs.job_budget_used_up"), deadline: tr("jobs.job_time_limit_reached"),
    worker_failed: tr("jobs.completion_cant_be_confirmed_yet"), interrupted: tr("jobs.job_was_interrupted_check_the"), configuration_changed: tr("jobs.job_settings_changed"), authorization_changed: tr("jobs.referenced_authorization_changed"), input_changed: tr("jobs.source_data_changed"), context_too_large: tr("jobs.context_too_large"), box_capacity: tr("jobs.box_capacity") };
  const route = (job: { route: Job["route"] }) => job.route.provider === "jit-service" && job.route.model === null && job.route.authRoute === "internal" ? tr("jobs.internal_jit_service_no_model")
    : `${job.route.provider} / ${job.route.model ?? tr("jobs.no_model")} · ${job.route.authRoute}`;
  const inspection = (job: Job) => {
    const detail = job as Job & Partial<Pick<ReturnType<Application["job"]>, "attempts" | "stop" | "reconciliations">>;
    const transport = { not_dispatched: tr("jobs.not_dispatched_yet"), cancellation_requested: tr("jobs.stop_requested_not_yet_confirmed"), observed_stopped: tr("jobs.stop_confirmed"), unknown: tr("jobs.stop_cant_be_confirmed_after") };
    return `${detail.stop ? `<p role="status">${tr("jobs.result_writing_closed")} ${transport[detail.stop.transport]}</p>` : ""}${detail.attempts?.length ? `<details><summary>${tr("jobs.run_history")} ${detail.attempts.length} ${tr("common.times")}</summary>${detail.attempts.map((attempt, index) => `<p>${tr("jobs.attempt")} ${index + 1} · ${attempt.state === "committed" ? tr("jobs.run_result_recorded") : attempt.state === "interrupted" || attempt.state === "rejected" ? tr("jobs.interrupted_not_authorized_to_record") : tr("jobs.awaiting_run_result")}</p>`).join("")}</details>` : ""}${detail.reconciliations?.filter(r => ["pending", "retire_failed", "delete_failed"].includes(r.lifecycle)).map(r => `<p class="error">${r.lifecycle === "delete_failed" ? tr("jobs.couldnt_delete_the_previous_context") : r.lifecycle === "retire_failed" ? tr("jobs.retirement_of_the_previous_context") : tr("jobs.checking_previous_context")} ${tr("jobs.replacement_context_not_usable_yet")}</p>`).join("") ?? ""}`;
  };
  const limits = (value: Job["limits"]) => `<dl class="job-limits"><dt>${tr("jobs.roles_calls_rounds_hops")}</dt><dd>${value.roles} / ${value.calls} / ${value.rounds} / ${value.hops}</dd><dt>${tr("label.context_output_tokens")}</dt><dd>${value.contextTokens} / ${value.outputTokens}</dd><dt>${tr("jobs.retries_time")}</dt><dd>${value.retries} / ${Math.ceil(value.wallMs / 1000)} ${tr("common.seconds")}</dd></dl>`;
  return shell(tr("common.project_jobs"), { project, workspace, csrf, section: "jobs" }, `<div class="content jobs-content"><section class="jobs-heading"><h2>${tr("jobs.jobs_in")} ${escape(project.name)}</h2><p>${tr("jobs.view_the_queue_limits_and")}</p></section>
    ${!state.admission.available ? `<p class="error" role="status">${tr("jobs.the_queue_has_stopped_accepting")}</p>` : ""}
    <section id="new-job" aria-label="${tr("jobs.start_job")}"${showStart ? "" : " hidden"}>${state.admission.available && state.choices.length ? state.choices.map(choice => `<form class="job-create" method="post" action="${base}">${hiddenCommand(csrf, project.revision)}
      <input type="hidden" name="type" value="${escape(choice.id)}"><input type="hidden" name="configurationRevision" value="${choice.revision}"><input type="hidden" name="policyRevision" value="${choice.policyRevision}"><input type="hidden" name="inputRevision" value="${project.revision}"><input type="hidden" name="input" value="{}"><input type="hidden" name="limits" value="${escape(JSON.stringify(policy.maximum))}">
      <label for="purpose-${escape(choice.id)}">${escape(choice.title)}</label><input id="purpose-${escape(choice.id)}" name="purpose" maxlength="300" required value="${escape(choice.title)}"><p>${escape(route(choice))}</p>
      <div class="job-create-actions"><select name="priority" aria-label="${tr("jobs.priority")}"><option value="interactive">${tr("jobs.foreground")}</option><option value="background">${tr("jobs.background")}</option></select><button class="primary">${tr("jobs.start")}${escape(choice.title)}</button></div><details><summary>${tr("jobs.scope_the_job_may_use")}</summary>${limits(policy.maximum)}</details></form>`).join("") : `<p class="empty-list">${tr("jobs.saved_jobs_are_viewable_the")}</p>`}</section>
    <section aria-label="${tr("jobs.job_queue")}">${state.items.length ? state.items.map(job => `<article class="job-card" id="job-${job.id}"><header><h3><a href="${base}/${job.id}">${escape(systemText(job.purpose))}</a></h3><span class="job-status" data-state="${job.state}">${labels[job.state]}</span></header><p>${reasons[job.reason]}</p><p class="job-route">${escape(route(job))}</p>
      ${job.occupiesAdmission && job.state !== "admitted" ? `<p>${tr("jobs.stop_requested_waiting_for_the")}</p>` : job.state === "waiting" ? `<p>${tr("jobs.ive_reviewed_the_reason_and")}</p><form method="post" action="${base}/${job.id}/resume">${hiddenCommand(csrf, job.revision)}<button class="primary">${tr("jobs.allow_resume")}</button></form>` : job.state === "blocked" || job.state === "failed" || job.state === "partial" ? `<p>${tr("jobs.check_evidence_and_limits_before")}</p>` : ""}
      ${["queued", "admitted", "waiting"].includes(job.state) ? `<form method="post" action="${base}/${job.id}/stop">${hiddenCommand(csrf, job.revision)}<button class="danger">${tr("jobs.stop_job_and_close_result")}</button></form>` : ""}
      ${inspection(job)}
      ${job.evidence ? `<div class="job-evidence">${literalContent(job.evidence)}</div>` : ""}<details><summary>${tr("jobs.details_and_remaining_budget")}</summary>${limits(job.remaining)}<dl class="job-limits"><dt>${tr("label.job_id")}</dt><dd>${escape(job.id)}</dd><dt>${tr("label.input_configuration_revision")}</dt><dd>${job.inputRevision} / ${job.configuration.revision}</dd><dt>${tr("jobs.updated")}</dt><dd>${time(job.updatedAt)}</dd></dl></details></article>`).join("") : `<p class="empty-list">${tr("jobs.no_jobs_in_this_project")}</p>`}</section>
    <nav class="pagination" aria-label="${tr("jobs.job_queue_pages")}">${after ? `<a href="${base}">${tr("common.first_page")}</a>` : ""}${state.hasMore ? `<a href="${base}?after=${state.nextAfter}">${tr("jobs.next_jobs")}</a>` : ""}</nav></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}
const deliveryLabels = (): Record<string, string> => ({
  waiting: tr("delivery.waiting_for_a_linked_channel"), queued: tr("delivery.request_saved_not_sent_yet"), claimed: tr("delivery.sending_result_unknown"),
  sent: tr("delivery.acknowledged_by_telegram"), failed: tr("common.send_failed"), unknown: tr("delivery.delivery_unknown"), cancelled: tr("common.cancelled_before_sending"),
});
const deliveryNext = (): Record<string, string> => ({
  wait_for_channel_binding: tr("delivery.wait_until_a_personal_channel"), wait_for_delivery: tr("delivery.waiting_for_the_system_to"),
  inspect_sent_message: tr("delivery.check_the_message_reference_telegram"), inspect_failure: tr("delivery.check_why_sending_failed"),
  inspect_unknown_then_explicit_resend: tr("delivery.check_the_unknown_status_then"),
  safe_retry_limit_reached: tr("delivery.automatic_retries_exhausted"), inspect_cancelled_intent: tr("delivery.this_request_was_cancelled_before"),
  authorization_changed: tr("delivery.owner_authorization_changed"), binding_revoked: tr("delivery.channel_link_revoked"), source_superseded: tr("delivery.report_superseded"),
  source_deleted: tr("delivery.source_deleted"), telegram_rejected: tr("delivery.destination_rejected_permanently"), telegram_unavailable: tr("delivery.destination_temporarily_unavailable"),
  unknown_transport: tr("delivery.result_unknown_after_sending_started"), not_bound: tr("delivery.no_channel_linked_yet"),
  wait_for_current_source: tr("delivery.held_until_the_source_is"), currentness_unavailable: tr("delivery.couldnt_verify_the_source_is"),
  candidate_superseded: tr("delivery.pr_has_a_new_revision"), revision_changed: tr("delivery.base_head_changed"), pr_closed: tr("delivery.pr_closed"),
  monitoring_revoked: tr("delivery.pr_tracking_revoked"), report_dismissed: tr("delivery.owner_turned_off_notifications_for"), finding_dismissed: tr("delivery.owner_turned_off_notifications_for_2"),
  alert_policy_changed: tr("delivery.notification_policy_changed"),
});

/** Lists logical notification intents. Rendering this page does not send. */
export function deliveryPage(state: ReturnType<Application["deliveries"]>, workspace: Workspace, csrf: string, after: number): string {
  const { project } = state;
  const base = `/projects/${project.id}/delivery`;
  return shell(tr("common.notifications"), { project, workspace, csrf, section: "settings", settings: "telegram" }, `<div class="content"><section class="hero"><p class="eyebrow">${tr("delivery.private_send_requests")}</p><h2>${tr("delivery.delivery_status")} ${escape(project.name)}</h2><p>${tr("delivery.saving_a_request_or_starting")}</p></section>
    <form class="create-form" method="post" action="${base}">${hiddenCommand(csrf, project.revision)}<label>${tr("common.type")}<select name="kind"><option value="report">${tr("delivery.report")}</option><option value="reminder">${tr("common.reminder")}</option></select></label><label>${tr("common.message")}<input name="text" required maxlength="4096"></label><label>${tr("delivery.unique_id")}<input name="dedupeKey" required minlength="8" maxlength="160" placeholder="report:example:1"></label><button class="primary">${tr("delivery.save_send_request")}</button></form>
    ${state.items.length ? `<ul>${state.items.map(item => `<li class="topic-row"><div class="topic-row-main"><h3><a href="${base}/${item.id}">${escape(deliveryLabels()[item.status] ?? item.status)}</a></h3><p>${escape(item.payload.kind === "reminder" ? tr("common.reminder") : tr("delivery.report"))} · ${escape(deliveryNext()[item.nextAction] ?? item.nextAction)}</p><p class="literal">${escape(item.payload.text)}</p></div></li>`).join("")}</ul>` : `<p class="empty-list">${tr("delivery.no_send_requests_yet")}</p>`}
    <nav class="pagination" aria-label="${tr("delivery.notification_pages")}">${after ? `<a href="${base}">${tr("common.first_page")}</a>` : ""}${state.hasMore ? `<a href="${base}?after=${state.nextAfter}">${tr("common.next")}</a>` : ""}</nav></div>`, { breadcrumb: { title: tr("settings.telegram"), href: "/settings/telegram" } });
}

/** Shows provenance, outcome and the next action for one intent. A resend warns that duplicates are possible. */
export function deliveryDetailPage(state: ReturnType<Application["delivery"]>, workspace: Workspace, csrf: string): string {
  const { project, intent, report } = state;
  const source = `/projects/${project.id}/sources/${report.sourceId}?revision=${report.sourceRevision}&generation=${report.sourceGeneration}`;
  const uncertain = intent.status === "failed" || intent.status === "unknown";
  return shell(tr("delivery.delivery_details"), { project, workspace, csrf, section: "settings", settings: "telegram" }, `<div class="content"><section class="hero"><p class="eyebrow">${tr("delivery.local_dedupe_only")}</p><h2>${escape(deliveryLabels()[intent.status] ?? intent.status)}</h2><p>${escape(deliveryNext()[intent.nextAction] ?? intent.nextAction)}</p><p>${tr("delivery.saving_a_request_or_starting")}</p></section>
    <article class="team-card"><p class="literal">${escape(intent.payload.text)}</p><p>${tr("delivery.request_status")} ${escape(intent.status)} ${tr("delivery.destination_result")} ${escape(intent.remote)} ${tr("delivery.guarantee")} ${escape(intent.guarantee)}</p>
    ${intent.failureReason ? `<p>${tr("delivery.reason")} ${escape(deliveryNext()[intent.failureReason] ?? intent.failureReason)}</p>` : ""}
    ${intent.stale ? `<p>${tr("delivery.this_result_occurred_while_the")}${escape(intent.staleReason ?? "")}${tr("delivery.the_system_did_not_suppress")}</p>` : ""}
    ${intent.resolution ? `<p data-resolution="${escape(intent.resolution.reason)}">${tr(intent.resolution.reason === "owner_answered" ? "delivery.resolved_owner_answered" : "delivery.resolved_no_longer_waiting")}</p>` : ""}
    ${intent.messageRef ? `<p>${tr("delivery.message_reference")} ${intent.messageRef.chatId} / ${intent.messageRef.messageId}</p>` : ""}
    ${uncertain ? `<p>${tr("delivery.the_source_report_is_still")}</p>` : ""}
    <p><a href="${source}">${tr("delivery.open_saved_report")}</a></p>
    ${["failed", "unknown", "sent"].includes(intent.status) ? `<form method="post" action="/projects/${project.id}/delivery/${intent.id}/resend">${hiddenCommand(csrf, intent.revision)}<p>${tr("delivery.sending_again_may_duplicate_the")}</p><button class="primary">${tr("delivery.send_again")}</button></form>` : ""}
    </article><details class="team-card"><summary>${tr("common.message_origin")}</summary><dl><dt>${tr("delivery.report")}</dt><dd>${escape(report.id)} ${tr("delivery.generation")} ${report.revision}/${report.generation} · ${escape(report.availability)}</dd><dt>${tr("delivery.authorization_data_generation")}</dt><dd>${intent.provenance.authorityGeneration} / ${intent.provenance.inputGeneration}</dd><dt>${tr("delivery.unique_id")}</dt><dd>${escape(intent.dedupeKey)}</dd><dt>${tr("delivery.attempts")}</dt><dd>${state.attempts.length}</dd></dl></details></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}/delivery` } });
}

export const prStatusLabels = (): Record<string, string> => ({
  running: tr("pr.reviewing"),
  complete_clean: tr("pr.reviewed_nothing_to_report"),
  complete_findings: tr("pr.reviewed_evidenced_findings"),
  partial: tr("pr.partly_reviewed_evidence_truncated"),
  incomplete: tr("pr.review_incomplete_required_analysis_miss"),
  failed: tr("pr.review_failed"),
});

const prReviewLabels = (): Record<string, string> => ({
  ...prStatusLabels(),
  not_reviewed: tr("pr.not_reviewed"),
  running: tr("pr.reviewing_no_report_yet"),
  stale: tr("pr.not_current_stale"),
  failed: tr("pr.review_failed"),
});

const transmissionLabels = (): Record<string, string> => ({ sent: tr("pr.sent_in_full"), truncated: tr("pr.truncated"), omitted: tr("pr.not_sent"), unavailable: tr("pr.unreadable") });

const prDeliveryLabels = (): Record<string, string> => ({
  waiting: tr("pr.waiting_for_channel"), queued: tr("pr.waiting_to_send"), claimed: tr("pr.sending"), sent: tr("pr.acknowledged_by_destination"),
  failed: tr("common.send_failed"), unknown: tr("pr.result_unknown"), cancelled: tr("common.cancelled_before_sending"),
});

export const prObservedState = (report: { stale: boolean; status: string }) =>
  report.stale ? "stale" : report.status === "complete_clean" ? "no_findings" : report.status === "complete_findings" ? "findings" : report.status;

const prDecisionLabels = (): Record<string, string> => ({
  notified: tr("pr.notification_request_recorded"), already_notified: tr("pr.already_notified_under_an_earlier"), held: tr("pr.not_notified_kept_in_report"), suppressed: tr("pr.notifications_suppressed"),
});

const prSeverities = ["info", "low", "medium", "high", "critical"] as const;

function alertPolicySummary(policy: ReturnType<Application["prReports"]>["policy"]): string {
  return `${tr("pr.notification_policy_v")}${policy.version}${policy.persisted ? "" : tr("pr.unsaved_default")} ${tr("pr.categories")} ${escape(policy.allowedCategories.join(", ") || tr("pr.none"))} ${tr("pr.minimum_severity")} ${escape(policy.minimumSeverity)} · ${policy.notifyPartial ? tr("pr.notify_partial_reports_with_a") : tr("pr.dont_notify_partial_reports")} ${tr("pr.evidence_and_actionability_always_requir")}`;
}

/** Lists private static review reports, unreviewed/running candidates and the owner alert policy; reading never admits work or sends. */
/** app.webhook_triggers/v1 owner view of a project's monitors and their triggers. */
type PrWebhooksState = ReturnType<Application["prWebhooks"]>;

/** app.webhook_triggers/v1 section of the PR page: each monitor's trigger with create, rotate and delete forms. */
function prWebhooksSection(projectId: string, webhooks: PrWebhooksState, csrf: string): string {
  const state = (monitor: (typeof webhooks.monitors)[number]) => monitor.trigger.state === "active" ? tr("pr.webhook_state_active")
    : monitor.trigger.state === "deleted" ? tr("pr.webhook_state_deleted") : tr("pr.webhook_state_none");
  const form = (monitor: (typeof webhooks.monitors)[number], action: "create" | "rotate" | "delete", label: string) =>
    `<form method="post" action="/projects/${projectId}/pr/monitors/${monitor.id}/webhook/${action}">${hiddenCommand(csrf, monitor.trigger.revision)}<button${action === "delete" ? "" : ` class="primary"`}>${label}</button></form>`;
  const rows = webhooks.monitors.map(monitor => `<li data-webhook-state="${escape(monitor.trigger.state)}" data-monitor-state="${escape(monitor.state)}"><h4>${tr("pr.webhook_monitor")} ${escape(monitor.repository)}</h4>
    <p>${state(monitor)} · ${tr("pr.webhook_next_poll")} ${monitor.state === "active" ? time(monitor.pollDueAt) : "-"}</p>
    ${monitor.pollFailure ? `<p data-poll-failure="${escape(monitor.pollFailure.reason)}">${tr("pr.webhook_poll_failed")} <span class="literal">${escape(monitor.pollFailure.reason)}</span> · ${time(monitor.pollFailure.at)}</p>` : ""}
    ${monitor.state === "paused" ? `<p>${tr("pr.webhook_monitor_paused")}</p>` : monitor.state === "revoked" ? `<p>${tr("pr.webhook_monitor_revoked")}</p>` : ""}
    ${monitor.trigger.state === "active" ? `<p class="literal">${tr("pr.webhook_path")} ${escape(monitor.trigger.path ?? "")}</p>${monitor.trigger.secretAvailable ? "" : `<p>${tr("pr.webhook_secret_missing")}</p>`}` : ""}
    ${monitor.trigger.state === "active" ? `${monitor.state === "revoked" ? "" : form(monitor, "rotate", tr("pr.webhook_rotate"))}${form(monitor, "delete", tr("pr.webhook_delete"))}`
      : monitor.state === "revoked" ? "" : form(monitor, "create", tr("pr.webhook_create"))}</li>`).join("");
  return `<article class="team-card" id="webhooks"><h3>${tr("pr.webhook_title")}</h3><p>${tr("pr.webhook_note")}</p>
    ${webhooks.monitors.length ? `<ul>${rows}</ul>` : `<p class="empty-list">${tr("pr.webhook_no_monitors")}</p>`}</article>`;
}

/** Shows a new webhook secret exactly once, right after create or rotate. The page is never cached. */
export function prWebhookSecretPage(state: { project: Project; receipt: WebhookReceipt; origin: string }, workspace: Workspace, csrf: string): string {
  const { project, receipt } = state;
  return shell(tr("pr.webhook_secret_title"), { project, workspace, csrf, section: "pr" }, `<div class="content"><section class="hero"><p class="eyebrow">${tr("pr.webhook_title")}</p><h2>${tr("pr.webhook_secret_title")}</h2><p>${tr("pr.webhook_secret_once")}</p></section>
    <article class="team-card" data-webhook-secret><p>${tr("pr.webhook_url")}</p><p class="literal">${escape(`${state.origin}${receipt.trigger.path ?? ""}`)}</p>
    <p>${tr("pr.webhook_secret")}</p><p class="literal">${escape(receipt.secret ?? "")}</p><p>${tr("pr.webhook_sender_help")}</p>
    <p><a href="/projects/${project.id}/pr/reports#webhooks">${tr("pr.webhook_back")}</a></p></article></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}/pr/reports` } });
}

export function prReportsPage(state: ReturnType<Application["prReports"]>, workspace: Workspace, csrf: string, webhooks?: PrWebhooksState): string {
  const { project, policy } = state;
  const categories = ["correctness", "security", "behavior"] as const;
  return shell(tr("pr.pr_review_reports"), { project, workspace, csrf, section: "pr" }, `<div class="content"><section class="hero"><p class="eyebrow">${tr("pr.private_static_review")}</p><h2>${tr("pr.reports_for")} ${escape(project.name)}</h2><p>${tr("pr.a_report_is_bound_only")}</p></section>
    <article class="team-card"><h3>${tr("pr.review_status_per_pr_revision")}</h3>${state.reviews.length ? `<ul>${state.reviews.map(item => `<li data-review-state="${escape(item.observed)}">${escape(`PR #${item.pullNumber} · ${item.baseSha.slice(0, 8)}...${item.headSha.slice(0, 8)}`)} · ${item.reportId ? `<a href="/projects/${project.id}/pr/reports/${item.reportId}">${escape(prReviewLabels()[item.observed] ?? item.observed)}</a>` : escape(prReviewLabels()[item.observed] ?? item.observed)}${item.staleReason ? ` (${escape(item.staleReason)})` : ""}${item.previousReportId ? ` · <a href="/projects/${project.id}/pr/reports/${item.previousReportId}">${tr("pr.earlier_reports_history")}</a>` : ""}${item.jobState ? ` ${tr("common.job")} ${escape(item.jobState)}/${escape(item.jobReason ?? "")}` : ""}</li>`).join("")}</ul>` : `<p class="empty-list">${tr("pr.no_tracked_prs_yet")}</p>`}</article>
    ${state.items.length ? `<ul>${state.items.map(item => `<li class="topic-row" data-state="${prObservedState(item)}"><div class="topic-row-main"><h3><a href="/projects/${project.id}/pr/reports/${item.id}">${escape(`PR #${item.pullNumber} · ${item.baseSha.slice(0, 8)}...${item.headSha.slice(0, 8)}`)}</a></h3><p>${escape(item.stale ? `stale (${item.staleReason ?? ""}${tr("pr.not_the_latest_result")}` : prStatusLabels()[item.status] ?? item.status)} · findings ${item.findings.filter(f => f.status === "actionable").length}/${item.findings.length}</p><p class="literal">coverage ${escape(item.coverageOverall)} · enum ${item.enumerationComplete ? tr("pr.complete") : tr("common.incomplete")} · roles ${escape(item.analyzedRoles.join(","))}</p></div></li>`).join("")}</ul>` : `<p class="empty-list">${tr("pr.no_pr_review_reports_yet")}</p>`}
    <article class="team-card"><h3>${tr("pr.notification_policy")}</h3><p>${alertPolicySummary(policy)}</p>
    <form method="post" action="/projects/${project.id}/pr/alert-policy">${hiddenCommand(csrf, policy.version)}
    <fieldset><legend>${tr("pr.categories_to_notify")}</legend>${categories.map(c => `<label><input type="checkbox" name="cat_${c}"${policy.allowedCategories.includes(c) ? " checked" : ""}> ${c}</label>`).join("")}</fieldset>
    <label>${tr("pr.minimum_severity_2")}<select name="minimumSeverity">${prSeverities.map(v => `<option value="${v}"${v === policy.minimumSeverity ? " selected" : ""}>${v}</option>`).join("")}</select></label>
    <label><input type="checkbox" name="notifyPartial"${policy.notifyPartial ? " checked" : ""}> ${tr("pr.notify_partial_reports_always_with")}</label>
    <button class="primary">${tr("pr.save_new_policy_version")}</button><small>${tr("pr.severity_doesnt_replace_evidence_doubts")}</small></form></article>
    ${webhooks ? prWebhooksSection(project.id, webhooks, csrf) : ""}
    </div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Shows one private report with findings, stored alert decisions, policy and linked delivery. */
export function prReportPage(state: ReturnType<Application["prReport"]>, workspace: Workspace, csrf: string): string {
  const { project, report, annotations, evaluation, alerts, evidence, policy, decision } = state;
  const transmitted = evidence.transmitted;
  const transmissionRows = (entries: NonNullable<typeof transmitted>["specialist"]) => entries.map(e => `<li data-transmission="${escape(e.state)}">${escape(e.kind)} ${escape(e.ref)} · ${escape(transmissionLabels()[e.state] ?? e.state)}${e.required ? "" : tr("pr.optional")} · ${e.sentBytes}/${e.bytes} bytes</li>`).join("");
  const observed = report.stale ? `stale (${report.staleReason ?? ""}${tr("pr.not_the_latest_result")}` : prStatusLabels()[report.status] ?? report.status;
  const dismissed = annotations.some(a => a.kind === "dismiss" && !a.findingId);
  return shell(tr("pr.pr_report_details"), { project, workspace, csrf, section: "pr" }, `<div class="content"><section class="hero" data-state="${prObservedState(report)}"><p class="eyebrow">${tr("pr.private_report_no_github_comments")}</p><h2>${escape(`PR #${report.pullNumber} · ${report.baseSha.slice(0, 8)}...${report.headSha.slice(0, 8)}`)}</h2><p>${escape(observed)} · coverage ${escape(report.coverageOverall)} · ${report.enumerationComplete ? tr("pr.enumeration_complete") : tr("pr.enumeration_incomplete")}</p><p>base ${escape(report.baseSha)} · head ${escape(report.headSha)} · policy v${report.policyVersion} · review v${report.reviewPolicyVersion} · revision ${report.revision}</p>${dismissed ? `<p>${tr("pr.the_owner_recorded_that_this")}</p>` : ""}</section>
    <article class="team-card"><h3>${tr("pr.findings")}${report.findings.length})</h3>${report.findings.length ? `<ul>${report.findings.map(f => `<li><strong>${escape(f.title)}</strong> [${escape(f.category)}/${escape(f.severity)}/${escape(f.status)}]<br><span class="literal">${escape(f.location.path)}${f.location.line ? `:${f.location.line}` : ""} · ${escape(f.evidenceType)}${f.evidenceRef ? ` ${escape(f.evidenceRef)}` : ""}</span><br><span>${escape(f.condition)}</span><br><span>${escape(f.impact)}</span>${f.validationErrors.length ? `<br><small>${tr("pr.reviewed")} ${escape(f.validationErrors.join(", "))}</small>` : ""}</li>`).join("")}</ul>` : `<p class="empty-list">${tr("pr.no_findings")}</p>`}
    <p>${tr("pr.analysis")} ${escape(report.analyzedRoles.join(", ") || "-")} ${tr("pr.required")} ${escape(report.requiredRoles.join(", "))} ${tr("pr.skipped")} ${escape(report.skippedScope.join(", ") || "-")}</p>
    ${report.disagreements.length ? `<p>${tr("pr.conflicts")} ${escape(report.disagreements.join(" · "))}</p>` : ""}</article>
    <article class="team-card"><h3>${tr("pr.sources_and_what_was_sent")}</h3>
    <p>route ${report.capture ? escape(`${report.capture.route.provider} / ${report.capture.route.model} · ${report.capture.route.authRoute} (${report.capture.layer}, owner r${report.capture.configuration.ownerRevision}/project r${report.capture.configuration.projectRevision})`) : "-"} · mode ${escape(report.mode ?? "-")}</p>
    ${evidence.coverage ? `<details><summary>source manifest (${evidence.coverage.entries.length})</summary><ul>${evidence.coverage.entries.map(e => `<li>${escape(e.kind)} ${escape(e.path ?? "")} · ${escape(e.state)}${e.immutableRef ? ` · ${escape(e.immutableRef)}` : ""}${e.reason ? ` (${escape(e.reason)})` : ""}</li>`).join("")}</ul></details>` : `<p>${tr("pr.no_source_manifest_found")}</p>`}
    ${transmitted ? `<details><summary>${tr("pr.sent_to_specialists")}${transmitted.specialist.length})</summary><ul>${transmissionRows(transmitted.specialist)}</ul></details><details><summary>${tr("pr.sent_to_synthesis")}${transmitted.synthesis.length})</summary><ul>${transmissionRows(transmitted.synthesis)}</ul></details>` : `<p>${tr("pr.no_delivery_record_completeness_cant")}</p>`}
    <p>specialists: ${escape(report.specialistRuns.map(r => `${r.role}=${r.state}${r.reason ? `/${r.reason}` : ""}`).join(", ") || "-")} · synthesis ${escape(`${report.synthesis.state}${report.synthesis.reason ? `/${report.synthesis.reason}` : ""}`)}</p>
    ${evidence.job ? `<p>${tr("common.job_2")} ${escape(evidence.job.state)}/${escape(evidence.job.reason)} · attempts ${evidence.attempts.length}</p><ul>${evidence.attempts.map(a => `<li>g${a.generation} · ${escape(a.state)}${a.reason ? `/${escape(a.reason)}` : ""} · transport ${escape(a.transport)}</li>`).join("")}</ul>` : ""}</article>
    <article class="team-card"><h3>${tr("pr.notifications_qualifying")} ${evaluation.qualifying.length} · held ${evaluation.held.length})</h3>
    <p>${alertPolicySummary(policy)}</p>
    ${decision ? `<div data-decision="${escape(decision.id)}"><p>${tr("pr.recorded_decision_policy_v")}${decision.policyVersion} · ${escape(decision.trigger)} · revision ${decision.reportRevision}${decision.suppressedReason ? ` ${tr("pr.whole_report_suppressed")} ${escape(decision.suppressedReason)}` : ""}</p><ul>${decision.findings.map(d => `<li data-finding-decision="${escape(d.decision)}">${escape(d.findingId)}: ${escape(prDecisionLabels()[d.decision] ?? d.decision)}${d.reason ? ` (${escape(d.reason)})` : ""}${d.intentId ? ` · <a href="/projects/${project.id}/delivery/${d.intentId}">${tr("pr.delivery_requests")}</a>` : ""}</li>`).join("")}</ul></div>` : `<p>${tr("pr.no_recorded_notification_assessment_yet")}</p>`}
    ${evaluation.qualifying.length ? `<details><summary>${tr("pr.preview_under_the_current_policy")}</summary><ul>${evaluation.qualifying.map(f => `<li>${escape(f.id)} · ${escape(f.title)}</li>`).join("")}</ul></details>` : `<p>${tr("pr.no_findings_meet_the_notification")}</p>`}
    ${evaluation.held.length ? `<details><summary>${tr("pr.held_back")}${evaluation.held.length})</summary><ul>${evaluation.held.map(h => `<li>${escape(h.finding.id)}: ${escape(h.reason)}</li>`).join("")}</ul></details>` : ""}
    ${alerts.length ? `<ul>${alerts.map(a => `<li data-delivery="${escape(a.status)}"><a href="/projects/${project.id}/delivery/${a.id}">${escape(prDeliveryLabels()[a.status] ?? a.status)} · ${escape(a.remote)}</a>${a.findingId ? ` · ${escape(a.findingId)}` : ""}${a.stale ? ` · stale (${escape(a.staleReason ?? "")}${tr("pr.not_the_latest_result")}` : ""}${a.failureReason && !a.stale ? ` · ${escape(a.failureReason)}` : ""} · ${escape(a.dedupeKey)}</li>`).join("")}</ul><p>${tr("pr.unknown_is_not_treated_as")}</p>` : `<p>${tr("pr.no_delivery_requests_for_this")}</p>`}</article>
    <article class="team-card"><h3>${tr("pr.owner_notes")}${annotations.length})</h3>
    ${annotations.length ? `<ul>${annotations.map(a => `<li>r${a.revision} · ${escape(a.kind)}${a.findingId ? ` · ${escape(a.findingId)}` : tr("pr.whole_report")} · ${escape(a.text)}</li>`).join("")}</ul>` : `<p>${tr("pr.no_additional_notes_yet")}</p>`}
    <form method="post" action="/projects/${project.id}/pr/reports/${report.id}">${hiddenCommand(csrf, report.revision)}<label>${tr("pr.finding")}<select name="findingId"><option value="">${tr("pr.whole_report_2")}</option>${report.findings.map(f => `<option value="${escape(f.id)}">${escape(f.id)}</option>`).join("")}</select></label><label>${tr("pr.reason_for_not_notifying_or")}<input name="reason" required maxlength="2000"></label><button class="primary">${tr("pr.record_as_no_notification_needed")}</button><small>${tr("pr.saved_as_a_new_annotation")}</small></form></article>
    </div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}/pr/reports` } });
}

/** Renders bounded owner configuration and explicitly authorized fixture previews. */
export function teamPage(state: ReturnType<Application["team"]>, workspace: Workspace, csrf: string, limits: JobPolicy["maximum"], preset?: string, models: RouteModels = noRouteModels): string {
  const project = state.project ?? undefined, base = project ? `/projects/${project.id}/team` : "/team";
  const routeFields = (route: RoleRoute | null, label: string) => `<fieldset class="team-route"><legend>${escape(label)}</legend>${routePicker({ route, models, legend: tr("label.provider"), layout: "select", inheritLabel: tr("team.use_the_next_levels_value") })}</fieldset>`;
  const names = { project_role: tr("team.project_role_override"), project_default: tr("team.project_default"), owner_role: tr("team.role_default"), owner_default: tr("team.owner_default"), missing: tr("team.not_set") };
  const presets: Record<string, { name: string; responsibility: string }> = { tech: { name: tr("team.technology"), responsibility: tr("team.analyzes_software_structure_correctness") }, design: { name: tr("team.design"), responsibility: tr("team.analyzes_user_experience_and_design") }, marketing: { name: tr("team.marketing"), responsibility: tr("team.analyzes_audiences_product_value_and") } };
  const example = preset ? presets[preset] : undefined;
  const roleForm = (role?: (typeof state.roles)[number]) => `<form class="team-form" method="post" action="/team/roles">${hiddenCommand(csrf, state.ownerRevision)}<input type="hidden" name="roleId" value="${role?.id ?? ""}"><label>${tr("team.role_name")}<input name="name" required maxlength="200" value="${escape(role?.name ?? example?.name ?? "")}"></label><label>${tr("common.type")}<select name="kind"><option value="specialist">${tr("label.specialist")}</option><option value="coordinator"${role?.kind === "coordinator" ? " selected" : ""}>${tr("label.coordinator")}</option></select></label><label>${tr("team.responsibility")}<textarea name="responsibility" required rows="3">${escape(role?.responsibility ?? example?.responsibility ?? "")}</textarea></label><label>${tr("common.status")}<select name="enabled"><option value="true">${tr("team.enabled")}</option><option value="false"${role?.enabled === false ? " selected" : ""}>${tr("team.disabled")}</option></select></label>${routeFields(role?.route ?? null, tr("team.role_route"))}<button class="primary">${role ? tr("team.save_role") : tr("team.create_role")}</button><small>${tr("team.saving_doesnt_start_work_or")}</small></form>`;
  return shell(project ? `${tr("team.team_for")} ${project.name}` : tr("common.team_and_models"), { workspace, csrf, ...(project ? { project, section: "team" as const } : { section: "settings" as const, settings: "team" as const }) }, `<div class="content team-content"><section class="hero"><p class="eyebrow">${tr("team.roles_and_responsibilities")}</p><h2>${project ? tr("team.choose_a_team_for_this") : tr("team.a_team_built_your_way")}</h2><p>${tr("team.define_duties_and_models_clearly")}</p></section><p class="team-notice">${tr("team.the_live_connection_hasnt_been")}</p>
    <details class="team-card"><summary>${project ? tr("team.project_default") : tr("team.owner_default")}</summary><form class="team-form" method="post" action="${base}/routes">${hiddenCommand(csrf, project ? state.projectRevision : state.ownerRevision)}<input type="hidden" name="roleId" value="">${routeFields(project ? state.projectDefault : state.ownerDefault, tr("team.defaults"))}<button class="primary">${tr("team.save_defaults")}</button></form></details>
    ${!project ? `<details class="team-card" id="new-role"${example || !state.roles.length ? " open" : ""}><summary>${tr("team.add_role")}</summary><p>${tr("team.create_your_own_or_start")} <a href="/settings/team?preset=tech#new-role">${tr("team.technology")}</a> · <a href="/settings/team?preset=design#new-role">${tr("team.design")}</a> · <a href="/settings/team?preset=marketing#new-role">${tr("team.marketing")}</a> ${tr("team.each_role_is_optional")}</p>${roleForm()}</details>` : `<p><a href="/settings/team">${tr("team.manage_all_roles_and_role")}</a></p>`}
    <section aria-label="${tr("common.role")}">${state.roles.length ? state.roles.map(role => `<article class="team-card" id="role-${role.id}"><header><h3>${escape(role.name)}</h3><span class="job-status" data-state="${role.enabled ? role.kind : "disabled"}">${role.enabled ? role.kind === "coordinator" ? tr("label.coordinator") : tr("label.specialist") : tr("team.disabled")}</span></header><p class="literal">${escape(role.responsibility)}</p><p class="team-effective">${role.effective.route ? escape(routeText(role.effective.route)) : tr("team.no_route_yet")}<br><small>${tr("team.source")} ${names[role.effective.layer]} · ${role.effective.status === "unverified" ? tr("team.set_live_connection_not_yet") : tr("team.cant_start_yet")}</small></p>
      ${project ? `<details><summary>${tr("team.adjust_the_route_for_this")}</summary><form class="team-form" method="post" action="${base}/routes">${hiddenCommand(csrf, state.projectRevision)}<input type="hidden" name="roleId" value="${role.id}">${routeFields(state.overrides[role.id] ?? null, tr("team.project_override"))}<button class="primary">${tr("team.save_override")}</button></form></details>
      ${role.enabled && role.effective.route && state.topics.length && state.previewAvailable ? `<form class="team-form team-preview" method="post" action="${base}/previews">${hiddenCommand(csrf, project.revision)}<input type="hidden" name="roleId" value="${role.id}"><input type="hidden" name="limits" value="${escape(JSON.stringify(limits))}"><label>${tr("team.send_sample_to_topic")}<select name="topicId">${state.topics.map(topic => `<option value="${topic.id}">${escape(topic.title ?? tr("common.topic_unavailable"))}</option>`).join("")}</select></label><label>${tr("team.what_to_try")}<input name="purpose" required maxlength="300" value="${tr("team.try_the_responsibility_of")} ${escape(role.name)}"></label><label>${tr("team.supporting_context")}<select name="sources"><option value="[]">${tr("team.no_source_data_attached")}</option>${state.topics.filter(topic => topic.availability === "available").map(topic => `<option value="${escape(JSON.stringify([topic.source]))}">${tr("team.topic_name")} ${escape(topic.title)}</option>`).join("")}</select></label><details><summary>${tr("team.budget_for_this_sample")}</summary><p>${limits.calls} calls · ${limits.rounds} rounds · ${limits.hops} hops · context ${limits.contextTokens} / output ${limits.outputTokens} tokens · ${Math.ceil(limits.wallMs / 1000)} ${tr("common.seconds")}</p><p>${tr("team.tools_none_no_shell_file")}</p></details><button class="primary">${tr("team.start_simulated_sample")}</button></form>` : `<p>${!role.enabled ? tr("team.enable_the_role_before_trying") : !role.effective.route ? tr("team.set_an_exact_route_before") : !state.topics.length ? tr("team.create_a_topic_in_the") : tr("team.the_queue_isnt_ready_for")}</p>`}` : `<details><summary>${tr("team.edit_role")}</summary>${roleForm(role)}</details>`}</article>`).join("") : `<p class="empty-list">${tr("team.no_roles_yet_start_with")}</p>`}</section><details class="team-card"><summary>${tr("team.route_selection_order")}</summary><p>${tr("team.project_role_override_project_default")}</p></details></div>`, project ? { breadcrumb: { title: project.name, href: `/projects/${project.id}` } } : {});
}

function decisionPanel(input: { projectId: string; topicId: string; topicRevision?: number; csrf: string; model: DecisionReadModel; discussion?: { id: string; revision: number; limits: JobLimits; canSynthesize: boolean } }): string {
  const { model, projectId, topicId, csrf } = input;
  const proposal = model.proposal;
  const running = model.synthesis?.state === "queued" || model.synthesis?.state === "running";
  const failed = model.synthesis && ["failed", "incomplete", "cancelled"].includes(model.synthesis.state)
    ? model.synthesis : null;
  const evidence = (items: DecisionReadModel["proposalEvidence"]) => items.map(item => item.state === "available"
    ? `<p>${escape(item.roleName ?? tr("common.source"))}${item.route ? ` · ${escape(`${item.route.provider} / ${item.route.model} · ${item.route.authRoute}`)}` : ""} ${sourceLink(projectId, item.reference, tr("common.evidence"))}</p>`
    : `<p class="error">${tr("common.source_unavailable")}${item.roleName ? ` · ${escape(item.roleName)}` : ""} (${escape(item.reason ?? "unavailable")})</p>`).join("");
  const history = model.decisions.map(entry => `<li>${entry.decision.supersededBy ? tr("common.superseded") : tr("decision.current")} · ${escape(entry.decision.conclusion)} · ${escape(entry.decision.rationale)} · proposal r${entry.decision.proposalRevision} · ${time(entry.decision.createdAt)}</li>`).join("");
  const choose = proposal && !running ? `<form class="team-form" method="post" action="/projects/${projectId}/topics/${topicId}/decisions">${hiddenCommand(csrf, proposal.revision)}
      <input type="hidden" name="proposalId" value="${proposal.id}"><input type="hidden" name="mode" value="${model.currentDecision ? "supersede" : "accept"}">
      ${model.currentDecision ? `<input type="hidden" name="decisionId" value="${model.currentDecision.decision.id}">` : ""}
      <label>${tr("decision.option")}<select name="optionId">${proposal.artifact.options.map(option => `<option value="${escape(option.id)}">${escape(option.label)}</option>`).join("")}<option value="own">${tr("decision.write_your_own_conclusion")}</option></select></label>
      <label>${tr("decision.your_conclusion")}<textarea name="conclusion" required maxlength="2000"></textarea></label>
      <label>${tr("decision.reason")}<textarea name="rationale" required maxlength="2000"></textarea></label>
      <button class="primary">${model.currentDecision ? tr("decision.replace_the_earlier_decision") : tr("decision.save_decision")}</button>
      <small>${tr("decision.this_records_your_decision_separate")}</small></form>` : "";
  const synthesize = input.discussion && !running ? `<form method="post" action="/projects/${projectId}/team/discussions/${input.discussion.id}/synthesis">${hiddenCommand(csrf, input.discussion.revision)}
      <input type="hidden" name="limits" value="${escape(JSON.stringify(input.discussion.limits))}"><button>${proposal ? tr("decision.ask_the_coordinator_to_summarize") : tr("decision.ask_the_coordinator_to_summarize_2")}</button></form>` : "";
  if (!proposal && !model.synthesis && !model.decisions.length && !input.discussion) return "";
  return `<section class="team-card" id="owner-decision"><h2>${tr("decision.summary_for_your_decision")}</h2>
    ${running ? `<p role=\"status\">${tr("decision.the_coordinator_is_summarizing_saved")}</p>` : ""}
    ${failed ? `<p class="error">${tr("decision.the_summary_isnt_a_decision")}${escape(failed.reason ?? failed.state)})</p>` : ""}
    ${proposal ? `<p>${proposal.artifact.disagreement || proposal.artifact.missing.length ? tr("decision.no_agreement_yet") : tr("decision.the_coordinator_sees_the_options")}</p>
      <p>${tr("decision.question")} ${escape(proposal.artifact.question)}</p>
      ${proposal.artifact.missing.length ? `<ul>${proposal.artifact.missing.map(gap => `<li>${tr("decision.missing_information")} ${escape(gap.roleName)} (${escape(gap.reason)})${unblockLine(null, gap.unblock)}</li>`).join("")}</ul>` : ""}
      <ul>${proposal.artifact.options.map(option => `<li><strong>${escape(option.label)}</strong> — ${escape(option.rationale)} ${option.citations.map(citation => sourceLink(projectId, citation.reference, citation.roleName)).join(" ")}</li>`).join("")}</ul>
      ${evidence(model.proposalEvidence)}<p>proposal r${proposal.revision}</p>` : `<p>${tr("decision.no_proposal_with_verified_citations")}</p>`}
    ${model.currentDecision ? `<p>${tr("decision.you_recorded_a_decision")} ${escape(model.currentDecision.decision.conclusion)}</p><p>${escape(model.currentDecision.decision.rationale)}</p>${evidence(model.currentDecision.evidence)}` : `<p>${tr("decision.no_decision_from_you_yet")}</p>`}
    ${history ? `<details><summary>${tr("decision.decision_history")}</summary><ul>${history}</ul></details>` : ""}
    ${choose}${proposal && input.topicRevision ? `<form class="team-form" method="post" action="/projects/${projectId}/tasks">${hiddenCommand(csrf, input.topicRevision)}<input type="hidden" name="topicId" value="${topicId}"><input type="hidden" name="source" value="${escape(JSON.stringify(proposal.source))}"><label>${tr("decision.task_title_from_verified_results")}<input name="title" required maxlength="200" value="${escape(proposal.artifact.question.slice(0, 200))}"></label><label>${tr("common.summary")}<textarea name="summary" required maxlength="2000">${escape(proposal.artifact.question)}</textarea></label><button>${tr("decision.propose_a_task_from_verified")}</button><small>${tr("decision.this_is_a_proposal_from")}</small></form>` : ""}${input.discussion?.canSynthesize ? synthesize : ""}</section>`;
}

const taskLabels = (): Record<string, string> => ({
  proposed: tr("tasks.proposal"), accepted: tr("tasks.accepted_awaiting_result_confirmation"), ready_for_review: tr("tasks.ready_for_close_review"),
  completed: tr("tasks.closed"), dismissed: tr("tasks.status_dismissed"), cancelled: tr("tasks.cancelled_after_acceptance"), superseded: tr("common.superseded"),
});
const policyLabels = (): Record<string, string> => ({
  owner_confirmed: tr("tasks.you_confirm_results_yourself_default"),
  evidence_satisfied: tr("tasks.can_close_once_evidence_meets"),
});
export function taskStatusText(task: { state: string; pendingReason?: { detail: string } | null; completionPolicy: { kind: string } }): string {
  const base = taskLabels()[task.state] ?? task.state;
  const policy = `${tr("tasks.policy")} ${policyLabels()[task.completionPolicy.kind] ?? task.completionPolicy.kind}`;
  const pending = task.pendingReason ? ` ${tr("tasks.pending")} ${escape(systemText(task.pendingReason.detail))}` : "";
  return `${base} · ${policy}${pending}`;
}

/** Renders proposals, accepted obligations, and closed tasks as separate lists. */
export function tasksPage(state: ReturnType<Application["tasks"]>, workspace: Workspace, csrf: string, topicId: string | null): string {
  const { project } = state;
  const selected = state.topics.find(topic => topic.id === topicId) ?? state.topics[0];
  const card = (task: (typeof state.proposed)[number]) => `<article class="team-card" id="task-${task.id}"><header><h3><a href="/projects/${project.id}/tasks/${task.id}">${escape(task.title)}</a></h3><span class="job-status" data-state="${task.state}">${escape(taskStatusText(task))}</span></header><p>${escape(task.summary)}</p><p>proposal r${task.proposalRevision} · ${task.origin === "owner" ? tr("tasks.proposed_by_you") : tr("tasks.cites_verified_results")}</p>${sourceLink(project.id, task.source, tr("tasks.source"))}</article>`;
  const group = (title: string, items: typeof state.proposed, empty: string) => `<section><h2 class="section-heading">${title}</h2>${items.length ? items.map(card).join("") : `<p class="empty-list">${empty}</p>`}</section>`;
  const form = selected ? `<form class="team-form" method="post" action="/projects/${project.id}/tasks">${hiddenCommand(csrf, selected.revision)}<input type="hidden" name="topicId" value="${selected.id}"><label>${tr("common.topic")}<p>${escape(selected.title ?? tr("common.topic_unavailable"))}</p></label><label>${tr("common.task_title")}<input name="title" required maxlength="200"></label><label>${tr("common.summary")}<textarea name="summary" required></textarea></label><button class="primary">${tr("common.save_as_proposal")}</button></form>` : `<p>${tr("tasks.create_a_topic_before_proposing")}</p>`;
  return shell(tr("common.tasks"), { workspace, csrf, project, topics: state.topics, section: "tasks" }, `<div class="content team-content"><section class="hero"><p class="eyebrow">${tr("tasks.proposals_are_separate_from_accepted")}</p><h2>${tr("tasks.tasks_for")} ${escape(project.name)}</h2><p>${tr("tasks.accepting_makes_it_your_obligation")}</p></section>
    <details class="team-card" id="new-task"${state.proposed.length ? "" : " open"}><summary>${tr("tasks.propose_a_task_from_a")}</summary>${form}</details>
    ${group(tr("tasks.proposals_not_yet_accepted"), state.proposed, tr("tasks.no_proposals_yet"))}
    ${group(tr("tasks.accepted_tasks"), state.accepted, tr("tasks.no_accepted_tasks_yet"))}
    ${group(tr("tasks.ready_for_close_review"), state.readyForReview, tr("tasks.no_tasks_awaiting_close_review"))}
    ${group(tr("tasks.closed"), state.completed, tr("tasks.no_closed_tasks_yet"))}
    ${group(tr("tasks.inactive_items"), state.inactive, tr("tasks.no_cancelled_or_superseded_items"))}
    ${Object.values(state.hasMore).some(Boolean) ? `<p role="status">${tr("tasks.showing_items_within_the_current")}</p>` : ""}</div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders one task, its proposal history, and owner actions that do not start execution. */
export function taskPage(state: ReturnType<Application["task"]>, workspace: Workspace, csrf: string, messageBytes: number): string {
  const { project, task, topic } = state;
  const base = `/projects/${project.id}/tasks/${task.id}`;
  const unavailable = state.source.state === "unavailable" ? `<p class="error">${tr("common.source_unavailable_2")}${escape(state.source.reason)})</p>` : sourceLink(project.id, task.source, tr("tasks.source_of_this_proposal"));
  const history = state.proposals.map(proposal => `<li>r${proposal.revision} · ${escape(proposal.title)} · ${escape(proposal.summary)} · ${proposal.origin === "owner" ? tr("common.you") : tr("tasks.verified_results")} · ${time(proposal.createdAt)}</li>`).join("");
  const events = state.events.map(event => `<li>${escape(taskLabels()[event.kind] ?? event.kind)} · ${event.channel} · ${event.actorId} · ${event.reason ? escape(event.reason) : ""} · ${time(event.createdAt)}</li>`).join("");
  const revise = task.state === "proposed" ? `<form class="team-form" method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="edit"><label>${tr("common.task_title")}<input name="title" required maxlength="200" value="${escape(task.title)}"></label><label>${tr("common.summary")}<textarea name="summary" required maxlength="${messageBytes}">${escape(task.summary)}</textarea></label><button>${tr("tasks.revise_proposal_as_a_new")}</button></form>
    <form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="dismiss"><input type="hidden" name="proposalId" value="${state.proposals.at(-1)?.id ?? ""}"><label>${tr("tasks.reason_for_dismissing_the_proposal")}<input name="reason" required maxlength="500"></label><button class="danger">${tr("tasks.dismiss_proposal")}</button></form>
    <form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="accept"><input type="hidden" name="proposalId" value="${state.proposals.at(-1)?.id ?? ""}"><button class="primary">${tr("tasks.accept_this_revision")}</button><small>${tr("tasks.you_are_the_one_accepting")}</small></form>` : "";
  const cancel = task.state === "accepted" || task.state === "ready_for_review" ? `<form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="cancel"><label>${tr("tasks.reason_for_cancelling")}<input name="reason" required maxlength="500"></label><button class="danger">${tr("tasks.cancel_accepted_task")}</button></form>` : "";
  const complete = task.state === "accepted" || task.state === "ready_for_review" ? `<form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="complete"><label>${tr("tasks.closing_note_not_the_models")}<input name="note" maxlength="500" placeholder="${tr("tasks.outcome_you_confirm")}"></label><button class="primary">${tr("tasks.confirm_close")}</button><small>${escape(taskStatusText(task))}</small></form>` : "";
  const reopen = task.state === "completed" ? `<form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="reopen"><label>${tr("tasks.reason_for_reopening")}<input name="reason" required maxlength="500"></label><button>${tr("tasks.reopen_after_review")}</button></form>` : "";
  const policyForm = task.state === "accepted" || task.state === "ready_for_review" ? `<form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="set_policy"><label>${tr("tasks.completion_policy")}<select name="policyKind"><option value="owner_confirmed"${task.completionPolicy.kind === "owner_confirmed" ? " selected" : ""}>${tr("tasks.you_confirm_the_outcome")}</option><option value="evidence_satisfied"${task.completionPolicy.kind === "evidence_satisfied" ? " selected" : ""}>${tr("tasks.requires_complete_evidence")}</option></select></label><button>${tr("tasks.save_policy")}</button></form>` : "";
  const evidence = state.evidenceArtifacts.length ? `<ul>${state.evidenceArtifacts.map(item => `<li>r${item.revision} · ${escape(item.workType)} · ${escape(item.outcome)}${item.deliveryState ? ` · ${escape(item.deliveryState)}` : ""} · ${sourceLink(project.id, item.source, tr("common.evidence"))}</li>`).join("")}</ul>` : `<p>${tr("tasks.no_evidence_yet_from_analysis")}</p>`;
  return shell(task.title, { workspace, csrf, project, topic, section: "tasks" }, `<div class="content team-content"><section class="hero"><p class="eyebrow">${escape(taskStatusText(task))} · proposal r${task.proposalRevision}</p><h2>${escape(task.title)}</h2><p>${escape(task.summary)}</p></section>
    <article class="team-card"><p>${tr("tasks.topic")} <a href="/projects/${project.id}/topics/${topic.id}">${escape(topic.title ?? tr("common.topic_unavailable"))}</a></p>${unavailable}
    ${task.acceptance ? `<p>${tr("tasks.accepted_by_owner_via")} ${escape(task.acceptance.channel)} · proposal r${task.acceptance.proposalRevision} · ${time(task.acceptance.acceptedAt)}</p>` : `<p>${tr("tasks.not_accepted_yet")}</p>`}
    ${task.completion ? `<p>${tr("tasks.closed_by_owner")} ${time(task.completion.completedAt)} · ${task.completion.note ? escape(task.completion.note) : tr("tasks.no_additional_notes")}</p>` : ""}
    ${task.closedReason ? `<p>${tr("tasks.reason_for_closing")} ${escape(task.closedReason)}</p>` : ""}
    <p>${tr("tasks.accepting_doesnt_open_a_shell")}</p></article>
    ${policyForm}<details open><summary>${tr("tasks.citable_evidence")}</summary>${evidence}</details>
    ${revise}${complete}${cancel}${reopen}
    <form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="start"><button>${tr("tasks.start_code_changes")}</button></form>
    <details><summary>${tr("tasks.proposal_history")}</summary><ul>${history}</ul></details>
    <details><summary>${tr("tasks.command_history")}</summary><ul>${events}</ul></details>
    <p><a href="/projects/${project.id}/tasks">${tr("tasks.back_to_tasks")}</a></p></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders one logical discussion with owner role controls, coordinator synthesis and the owner decision form. */
export function discussionPage(state: ReturnType<Application["discussion"]>, workspace: Workspace, csrf: string, limits: JobLimits): string {
  const { project, discussion: d } = state;
  const labels: Record<string, string> = { queued: tr("common.queued"), running: tr("discussion.analyzing"), completed: tr("common.saved"), blocked: tr("common.hit_a_limit"), stopped: tr("discussion.stopped"), skipped: tr("discussion.skipped"), excluded: tr("discussion.excluded") };
  const controls = (roleId: string, revision: number) => (["include", "exclude", "skip", "stop"] as const).map(action =>
    `<form method="post" action="/projects/${project.id}/team/discussions/${d.id}/controls">${hiddenCommand(csrf, revision)}<input type="hidden" name="roleId" value="${roleId}"><input type="hidden" name="action" value="${action}"><button${action === "stop" ? ' class="danger"' : ""}>${tr(`discussion.action_${action}`)}</button></form>`).join("");
  return shell(tr("discussion.team_discussion"), { workspace, csrf, project, section: "team" }, `<div class="content team-content"><section class="hero"><p class="eyebrow">${tr("discussion.fixture_separate_analyses_not_yet")}</p><h2>${escape(d.purpose)}</h2><p>${escape(d.router.evidence)} ${tr("discussion.gaps")} ${d.coverageGap.length}</p></section>
    ${d.participations.map(item => `<article class="team-card" id="role-${item.roleId}"><header><h3>${escape(item.roleName)}</h3><span class="job-status" data-state="${escape(item.state)}">${labels[item.state] ?? item.state}</span>${item.result ? resultPill(item.result) : ""}</header>
      ${item.result?.status === "blocked" ? unblockLine(null, item.result.unblock) : ""}
      <p>${item.route ? escape(`${item.route.provider} / ${item.route.model} · ${item.route.authRoute}`) : tr("discussion.no_route")} · ${escape(item.reason ?? "")}</p>
      ${item.progress ? `<p role="status">${tr("discussion.interim_progress")} ${escape(item.progress.text)}</p>` : ""}
      ${item.output ? sourceLink(project.id, item.output, tr("discussion.saved_results")) : `<p>${tr("discussion.no_confirmed_results_yet")}</p>`}
      <p><a href="/projects/${project.id}/jobs/${item.jobId}">${tr("discussion.view_job")}</a></p><div class="team-form">${controls(item.roleId, d.revision)}</div></article>`).join("")}
    ${state.context ? contextPanel(state.context, tr("discussion.context_the_team_used")) : ""}${state.synthesisContext ? contextPanel(state.synthesisContext, tr("common.coordinator_context")) : ""}
    ${decisionPanel({ projectId: project.id, topicId: d.topicId, csrf, model: state.decision, discussion: { id: d.id, revision: d.revision, limits, canSynthesize: d.participations.some(item => item.state === "completed") } })}
    <p><a href="/projects/${project.id}/topics/${d.topicId}">${tr("discussion.back_to_topic")}</a></p></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders retained fixture evidence and its captured configuration without implying successful live inference. */
export function previewPage(state: ReturnType<Application["preview"]>, workspace: Workspace, csrf: string): string {
  const { project, run, job } = state, r = run.request;
  const reasons = { complete: tr("preview.preview_result_saved"), unknown_model: tr("preview.preview_selected_model_id_not"), route_unavailable: tr("preview.preview_selected_connection_isnt_ready"), quota: tr("preview.preview_selected_route_hit_its"), needs_login: tr("preview.preview_selected_route_requires_sign"), cancelled: tr("preview.preview_cancelled"), max_rounds: tr("preview.preview_reached_its_allowed_number"), budget_exhausted: tr("preview.preview_used_its_full_budget"), invalid_result: tr("preview.preview_result_cant_be_confirmed"), context_retired: tr("preview.preview_context_has_been_retired") };
  const jobs = { queued: tr("preview.preview_is_queued"), admitted: tr("preview.running_simulated_preview"), waiting: tr("preview.preview_awaiting_review_before_continuin"), succeeded: tr("preview.preview_run_result_saved"), blocked: tr("preview.preview_hit_a_limit"), partial: tr("preview.preview_partially_complete"), failed: tr("preview.preview_didnt_succeed") };
  return shell(tr("preview.simulated_preview_result"), { workspace, csrf, project, section: "team" }, `<div class="content team-content"><section class="hero"><p class="eyebrow">${tr("preview.fixture_no_real_service_called")}</p><h2>${escape(run.roleName)}</h2><p>${escape(r.purpose)}</p></section><article class="team-card"><p role="status">${run.outcome ? reasons[run.outcome.reason] : jobs[job.state]}</p>${run.outcome?.output ? literalContent(run.outcome.output) : `<p>${tr("preview.no_confirmed_successful_result_yet")}</p>`}<p>${tr("preview.this_is_a_simulated_preview")}</p>${run.source ? sourceLink(project.id, run.source, tr("preview.saved_sources_with_provenance")) : ""}<p><a href="/projects/${project.id}/topics/${run.topicId}">${tr("preview.open_history_in_topic")}</a> · <a href="/projects/${project.id}/jobs/${run.jobId}">${tr("preview.view_queue_and_remaining_budget")}</a> · <a href="/projects/${project.id}/team">${tr("preview.back_to_team")}</a></p></article><details class="team-card"><summary>${tr("preview.settings_used_for_this_preview")}</summary><p>${tr("label.requested_route")} ${escape(`${r.route.provider} / ${r.route.model} · ${r.route.authRoute}`)}</p><p>${tr("preview.execution_scripted_fixture_no_real")}</p><p>${tr("label.owner_project_role_revision")} ${r.configuration.ownerRevision} / ${r.configuration.projectRevision} / ${r.configuration.roleRevision}</p><p class="literal">${tr("preview.responsibility")} ${escape(r.instructions.responsibility)}</p><p>${tr("label.managed_context")} ${escape(r.context.id)} / ${r.context.generation}</p><p>${tr("preview.sources")} ${r.manifest.sources.length} ${tr("preview.tools_none")}</p><p>${tr("preview.editing_current_settings_doesnt_change")}</p></details></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders local owner sign-in without scripts, external assets or credentials in markup. */
export function loginPage(): string {
  return documentPage(tr("common.sign_in"), `<main class="auth" id="main-content"><div class="auth-card">${brand()}<h1>${tr("login.welcome_back")}</h1><p>${tr("login.a_space_for_your_projects")}</p><form method="post" action="/login"><label for="password">${tr("login.owner_password")}</label><input id="password" name="password" type="password" maxlength="256" required autocomplete="current-password"><button class="primary">${tr("common.sign_in")}</button></form><footer class="auth-footer">${tr("login.jit_personal_project_space")}</footer></div></main>`);
}
/** Renders a safe fixed rejection message with accessible recovery navigation. */
export function errorPage(message: string, recovery?: { href: string; label: string }): string {
  const next = recovery ? `<a href="${escape(recovery.href)}">${escape(recovery.label)}</a>` : "";
  return documentPage(tr("error_page.check_the_command"), `<main class="auth" id="main-content"><div class="auth-card">${brand()}<h1>${tr("error_page.check_the_command")}</h1><p class="error" role="alert">${escape(message)}</p><div class="error-actions">${next}<a href="/">${tr("error_page.open_project_page")}</a><a href="/login">${tr("common.sign_in")}</a></div></div></main>`);
}

const claimUrl = (projectId: string, ref: import("./memory/types").ClaimReference) => `/projects/${projectId}/memory/claims/${ref.claimId}?revision=${ref.revision}&generation=${ref.generation}`;
function memoryClaimContent(item: import("./memory/types").ClaimLookup, projectId: string): string {
  const dependencies = (label: string, refs: import("./memory/types").ClaimReference[]) => refs.length ? `<p>${label}</p><ul>${refs.map(ref => `<li><a href="${claimUrl(projectId, ref)}">${escape(ref.claimId)} · revision ${ref.revision}</a></li>`).join("")}</ul>` : "";
  const decision = (ref: import("./memory/types").MemoryDecisionReference | null) => ref ? `<p><a href="/projects/${projectId}/topics/${ref.topicId}#owner-decision">${tr("memory_claim.open_owner_decision_revision")} ${ref.revision}</a> · ${escape(ref.id)}</p>` : "";
  if (item.state !== "available") {
    const p = item.provenance;
    return `<article class="team-card"><h2>${tr("memory_claim.memory_unavailable")}</h2><p>${escape(item.reason)}</p><p>${tr("label.claim")} ${escape(item.reference.claimId)} · revision ${item.reference.revision} · generation ${item.reference.generation}</p>${p ? `<p>${sourceLink(projectId, p.source, `${tr("memory_claim.check_source_revision")} ${p.source.revision} · generation ${p.source.generation}`)}</p>${dependencies(tr("memory_claim.check_the_memory_it_derives"), p.dependencies)}${dependencies(tr("memory_claim.check_conflicts"), p.conflicts)}${decision(p.decision)}` : ""}</article>`;
  }
  const c = item.claim;
  return `<article class="team-card" id="claim-${c.claimId}"><h2>${c.kind === "explicit_fact" ? tr("memory_claim.fact_owner_said_this") : tr("memory_claim.inference_inferred_claim")}</h2><p>${tr("memory_claim.status_active_origin_project")} ${escape(projectId)}</p>${literalContent(c.text)}
    <p>${sourceLink(projectId, c.source, `${tr("memory_claim.open_source_revision")} ${c.source.revision} · generation ${c.source.generation}`)} · ${item.source.state === "available" ? escape(attributionLabel(item.source.attribution)) : tr("common.source_unavailable")}</p>
    <details><summary>${tr("memory_claim.evidence_text_and_source")}</summary><blockquote>${literalContent(c.quote)}</blockquote><p><a href="${claimUrl(projectId, c)}">${tr("label.claim")} ${c.claimId}</a> · revision ${c.revision} · generation ${c.generation} · ${time(c.createdAt)}</p>${dependencies(tr("memory_claim.derived_from_memory"), c.dependencies)}${dependencies(tr("memory_claim.conflicts_with_memory_both_kept"), c.conflicts)}${decision(c.decision)}</details></article>`;
}

/** Renders exact claim lineage without any model calls or inferred owner authority. */
export interface ClaimCorrectionView {
  correction: import("./memory/types").MemoryCorrection | null;
  impact: import("./memory/types").CorrectionImpact | null;
  suppression: import("./memory/types").MemorySuppression | null;
  forgetImpact: import("./memory/types").SuppressionImpact | null;
  ledger: import("./memory/types").SuppressionLedger | null;
  sources: { reference: import("./sources").SourceReference; label: string }[];
  revision: number;
}
export function memoryClaimPage(state: import("./memory/types").ClaimLookup, extra: ClaimCorrectionView, project: Project, workspace: Workspace, csrf: string): string {
  return shell(tr("memory_claim.memory_provenance"), { workspace, csrf, project, section: "memory" }, `<div class="content memory-content"><p><a href="/projects/${project.id}/memory">${tr("common.back_to_project_memory")}</a></p>${memoryClaimContent(state, project.id)}${correctionPanel(state, extra, project.id, csrf)}${suppressionPanel(state, extra, project.id, csrf)}</div>`);
}

function suppressionPanel(item: import("./memory/types").ClaimLookup, extra: ClaimCorrectionView, projectId: string, csrf: string): string {
  if (extra.suppression) {
    const s = extra.suppression, ledger = extra.ledger;
    const retire = ledger ? `<p>${tr("memory_claim.context_retirement")} <strong>${ledger.retire.state === "complete" ? tr("memory_claim.complete") : tr("memory_claim.incomplete")}</strong> ${tr("memory_claim.tracked_contexts")} ${ledger.retire.contexts.length} ${tr("common.items")}${ledger.retire.contexts.filter(c => c.lifecycle !== "retired" && c.lifecycle !== "deleted").map(c => ` · ${escape(c.id)} (${escape(c.lifecycle)})`).join("")}</p><p>${escape(systemText(ledger.note))}</p>` : "";
    return `<section class="team-card" id="memory-suppression"><h2>${tr("memory_claim.this_memory_has_been_forgotten")}</h2><p>${tr("memory_claim.withdraw_memory")} ${s.withdrawn.length} ${tr("memory_claim.items_linked_to_the_original")} ${s.sources.length} ${tr("memory_claim.sets_reason")} ${escape(s.reason)}</p>${retire}<p>${tr("memory_claim.future_answers_and_context_wont")}</p></section>`;
  }
  if (item.state !== "available" || !extra.forgetImpact) return "";
  const impact = extra.forgetImpact;
  const overlap = impact.overlaps.length ? `<p><strong>${tr("memory_claim.this_text_overlaps_with")}${impact.overlaps.map(o => o.kind === "task" ? tr("common.job_2") : tr("memory_claim.decisions")).join(tr("memory_claim.and"))}${tr("memory_claim.still_active")} ${impact.overlaps.length} ${tr("common.items")}</strong> ${tr("memory_claim.forgetting_wont_cancel_or_withdraw")}</p>` : "";
  const summary = `<p>${tr("memory_claim.impact_of_forgetting_memory_that")} ${impact.dependents.length} ${tr("memory_claim.items_memory_from_the_same")} ${impact.siblings.length} ${tr("memory_claim.items_run_contexts_that_used")} ${impact.contexts.length} ${tr("memory_claim.items_pending_jobs_that_will")} ${impact.pendingJobs.length} ${tr("common.items")}</p>`;
  return `<section class="team-card" id="memory-forget"><h2>${tr("memory_claim.forget_this_memory")}</h2>${summary}${overlap}
    <p>${tr("memory_claim.forgetting_withdraws_only_the_selected")}</p>
    <form class="team-form" method="post" action="/projects/${escape(projectId)}/memory/claims/${escape(item.claim.claimId)}">${hiddenCommand(csrf, extra.revision)}
      <input type="hidden" name="mode" value="forget"><input type="hidden" name="revision" value="${item.claim.revision}"><input type="hidden" name="generation" value="${item.claim.generation}">
      <label>${tr("memory_claim.reason_for_forgetting")}<input name="reason" required maxlength="500" placeholder="${tr("memory_claim.e_g_the_owner_asked")}"></label>
      <label><input type="checkbox" name="acknowledged" value="on" required> ${tr("memory_claim.i_understand_the_scope_no")}</label>
      <button class="primary">${tr("memory_claim.confirm_forget")}</button></form></section>`;
}

function correctionPanel(item: import("./memory/types").ClaimLookup, extra: ClaimCorrectionView, projectId: string, csrf: string): string {
  if (extra.correction) {
    const c = extra.correction;
    return `<section class="team-card" id="memory-correction"><h2>${tr("memory_claim.this_memory_has_been_corrected")}</h2><p>${tr("memory_claim.replaced_with")} <a href="${claimUrl(projectId, c.replacement)}">claim ${escape(c.replacement.claimId)}</a> · revision ${c.replacement.revision} · generation ${c.replacement.generation}</p><p>${tr("common.reason")} ${escape(c.reason)}</p><p>${tr("memory_claim.future_answers_and_context_use")}</p></section>`;
  }
  if (item.state !== "available" || !extra.impact) return "";
  const impact = extra.impact, capped = (n: number, cut: boolean) => cut ? `${tr("memory_claim.at_least")} ${n} ${tr("memory_claim.partial_list")}` : `${n}`;
  const summary = `<p>${tr("memory_claim.impact_of_correction_memory_that")} ${capped(impact.dependents.length, impact.truncated.dependents)} ${tr("memory_claim.items_run_contexts_that_used_2")} ${capped(impact.contexts.length, impact.truncated.contexts)} ${tr("memory_claim.items_pending_jobs_that_will")} ${capped(impact.pendingJobs.length, impact.truncated.pendingJobs)} ${tr("common.items")}</p>`;
  const options = extra.sources.length ? extra.sources.map(({ reference, label }) => `<option value="${escape(JSON.stringify(reference))}">${escape(label)}</option>`).join("")
    : `<option value="">${tr("memory_claim.no_source_available_for_correction")}</option>`;
  return `<section class="team-card" id="memory-correct"><h2>${tr("memory_claim.correct_this_memory")}</h2>${summary}
    <p>${tr("memory_claim.correcting_doesnt_change_accepted_tasks")}</p>
    ${extra.sources.length ? `<form class="team-form" method="post" action="/projects/${escape(projectId)}/memory/claims/${escape(item.claim.claimId)}">${hiddenCommand(csrf, extra.revision)}
      <input type="hidden" name="revision" value="${item.claim.revision}"><input type="hidden" name="generation" value="${item.claim.generation}">
      <label>${tr("memory_claim.corrected_text")}<textarea name="text" required maxlength="2048">${escape(item.claim.text)}</textarea></label>
      <label>${tr("memory_claim.quoted_evidence_must_appear_in")}<textarea name="quote" required maxlength="2048">${escape(item.claim.quote)}</textarea></label>
      <label>${tr("memory_claim.source_supporting_the_correction")}<select name="source">${options}</select></label>
      <label>${tr("memory_claim.reason_for_correction")}<input name="reason" required maxlength="500" placeholder="${tr("memory_claim.e_g_the_owner_shared")}"></label>
      <button class="primary">${tr("memory_claim.confirm_correction")}</button></form>` : `<p>${tr("memory_claim.no_source_available_yet_to")}</p>`}</section>`;
}

const contextLayers = (): Record<import("./memory/types").ContextProvenanceEntry["layer"], string> => ({
  pinned_decision: tr("memory_context.pinned_owner_decisions"), project_constraint: tr("memory_context.current_tasks_and_decisions_project"), explicit_preference: tr("memory_context.what_youve_stated_in_this"),
  source_evidence: tr("memory_context.sources_selected_for_this_run"), inference: tr("memory_context.inferences_not_requirements"),
});
function contextEntry(entry: import("./memory/types").MemoryContextView["entries"][number]): string {
  const p = entry.projectId, version = `revision ${entry.revision}${entry.generation === null ? "" : ` · generation ${entry.generation}`}`;
  const href = entry.kind === "task" ? `/projects/${p}/tasks/${entry.id}`
    : entry.kind === "decision" ? `/projects/${p}/topics/${entry.topicId}#owner-decision`
    : entry.kind === "claim" ? claimUrl(p, { claimId: entry.id, revision: entry.revision, generation: entry.generation! })
    : `/projects/${p}/sources/${entry.id}?revision=${entry.revision}&generation=${entry.generation}`;
  const label = entry.kind === "task" ? `${tr("common.job_2")} ${entry.status}` : entry.kind === "decision" ? tr("memory_context.your_decision")
    : entry.kind === "claim" ? (entry.claimKind === "explicit_fact" ? tr("memory_context.fact_owner_said") : tr("memory_context.inference")) : tr("common.source_2");
  return `<li data-context-entry="${escape(entry.kind)}" data-current="${entry.current}"><a href="${escape(href)}">${escape(label)} · ${escape(entry.id)}</a> · ${version}${entry.scope === "cross_project" ? ` ${tr("memory_context.from_another_project")} ${escape(p)} ${tr("memory_context.not_a_preference_for_this")}` : ""}
    ${entry.current ? "" : ` · <strong>${tr("memory_context.no_longer_current")} ${escape(entry.reason ?? "unavailable")}</strong>`}${entry.text ? `<p class="literal">${escape(entry.text)}</p>` : ""}
    ${entry.source && entry.kind !== "source" ? sourceLink(p, entry.source, `${tr("memory_context.evidence_revision")} ${entry.source.revision} · generation ${entry.source.generation}`) : ""}</li>`;
}
function contextPanel(state: import("./memory/types").MemoryContextView, title: string): string {
  const r = state.record, o = r.omitted;
  const groups = (Object.keys(contextLayers()) as (keyof ReturnType<typeof contextLayers>)[]).map(layer => {
    const items = state.entries.filter(entry => entry.layer === layer);
    return items.length ? `<h4>${contextLayers()[layer]}</h4><ul>${items.map(contextEntry).join("")}</ul>` : "";
  }).join("");
  const notes = [
    o.constraints || o.claims || o.budget ? `${tr("memory_context.context_incomplete_omitted_tasks_decisio")} ${o.constraints} ${tr("memory_context.and_memory")} ${o.claims} ${tr("memory_context.items_due_to_budget")}` : "",
    o.loopGuard ? tr("memory_context.no_additional_memory_retrieved_because") : "",
    o.unavailable ? `${tr("memory_context.withdrawn_or_unavailable_memory")} ${o.unavailable} ${tr("memory_context.items_not_used")}` : "",
    r.packet?.omissions.length ? `${tr("memory_context.packet_sections_trimmed")} ${r.packet.omissions.map(item => `${item.section} (${item.reason}${item.items ? ` ${item.items}` : ""})`).join(", ")}` : "",
    state.entries.some(entry => entry.layer !== "source_evidence") ? "" : tr("memory_context.no_project_state_or_memory"),
  ].filter(Boolean).map(text => `<p role="note">${escape(text)}</p>`).join("");
  const conflicts = r.conflicts.length ? `<h4>${tr("memory_context.conflicts_for_you_to_decide")}</h4><ul>${r.conflicts.map(item => `<li><a href="${claimUrl(item.claim.projectId, item.claim)}">${escape(item.claim.claimId)}</a> ↔ <a href="${claimUrl(item.claim.projectId, item.with)}">${escape(item.with.claimId)}</a>${item.included ? "" : tr("memory_context.other_side_not_in_this")}</li>`).join("")}</ul>` : "";
  return `<section class="team-card" id="context-${r.id}" aria-label="${escape(title)}"><h3>${escape(title)}</h3>
    <p>app.memory_context/v1 · policy ${r.policy.version} · ${state.current ? tr("memory_context.all_items_are_still_current") : `<strong>${tr("memory_context.some_items_have_changed_results")}</strong>`} · ${r.complete ? tr("memory_context.complete_within_budget") : tr("common.incomplete")}</p>
    ${notes}${groups}${conflicts}<p><a href="/projects/${r.projectId}/memory/contexts/${r.id}">${tr("memory_context.view_context_the_run_used")}</a> · ${time(r.snapshot.assembledAt)}</p></section>`;
}

/** app.context_provenance/v1: what one run was allowed to use, with current lifecycle status and clickable evidence. */
export function memoryContextPage(state: ReturnType<Application["memoryContext"]>, workspace: Workspace, csrf: string): string {
  const { project, ...view } = state;
  return shell(tr("memory_context.context_the_run_used"), { workspace, csrf, project, section: "memory" }, `<div class="content memory-content">${contextPanel(view, view.record.owner.kind === "synthesis" ? tr("common.coordinator_context") : view.record.owner.kind === "schedule" ? tr("memory_context.scheduled_summary_context") : tr("memory_context.discussion_context"))}
    <p><a href="/projects/${project.id}/memory">${tr("common.back_to_project_memory")}</a></p></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders bounded source selection, fixture extraction status and active-generation claim inspection. */
export function memoryPage(state: ReturnType<Application["memory"]>, workspace: Workspace, csrf: string, limits: JobLimits, cursor: { after: number; sourceAfter: number; extractionAfter: number }): string {
  const p = state.project, roles = state.team.roles.filter(role => role.enabled && role.effective.route);
  const href = (patch: Partial<typeof cursor>) => `/projects/${p.id}/memory?${new URLSearchParams({ q: state.query, ...Object.fromEntries(Object.entries({ ...cursor, ...patch }).map(([k, v]) => [k, String(v)])) })}`;
  const usable = state.sources.filter(item => item.source.state === "available" && !item.suppressed);
  const excluded = state.sources.filter(item => item.suppressed && item.source.state === "available");
  const available = state.extractionAvailable && roles.length && state.topics.length && usable.length > 0;
  return shell(tr("memory.project_memory"), { workspace, csrf, project: p, topics: state.topics, section: "memory" }, `<div class="content memory-content"><section class="hero"><h2>${tr("memory.memory_with_traceable_sources")}</h2><p>${tr("memory.a_fact_only_confirms_that")} <a href="/projects/${p.id}/tasks">${tr("common.tasks")}</a> ${tr("memory.and_the_projects_topics")}</p><p>${tr("memory.extraction_in_this_build_is")}</p></section>
    <form class="team-form" method="get"><label>${tr("memory.search_memory")} <input name="q" value="${escape(state.query)}" maxlength="200" placeholder="${tr("memory.thai_or_english_terms")}"></label><button>${tr("memory.search")}</button></form>
    <section><h2>${tr("memory.saved_memory")}</h2>${state.items.length ? state.items.map(item => memoryClaimContent(item, p.id)).join("") : `<p class="empty-list">${tr("memory.no_memory_on_this_page")}</p>`}
    <nav class="pagination" aria-label="${tr("memory.memory_pages")}">${cursor.after ? `<a href="${escape(href({ after: 0 }))}">${tr("memory.first_memory_page")}</a>` : ""}${state.nextAfter !== null ? `<a href="${escape(href({ after: state.nextAfter }))}">${tr("memory.next_memory_page")}</a>` : ""}</nav></section>
    <section><h2>${tr("memory.extract_from_saved_sources")}</h2><p>${tr("memory.one_request_per_source_revision")}</p>
    ${available ? `<form class="team-form" method="post" action="/projects/${p.id}/memory">${hiddenCommand(csrf, p.revision)}<input type="hidden" name="limits" value="${escape(JSON.stringify(limits))}">
      <label>${tr("common.role")} <select name="roleId">${roles.map(role => `<option value="${role.id}">${escape(role.name)} · ${escape(role.effective.route!.model)}</option>`).join("")}</select></label>
      <label>${tr("memory.related_topic")} <select name="topicId">${state.topics.map(topic => `<option value="${topic.id}">${escape(topic.title)}</option>`).join("")}</select></label>
      <label>${tr("common.source_2")} <select name="source">${usable.map(({ source, decision }) => source.state === "available" ? `<option value="${escape(JSON.stringify(source.reference))}">${escape(decision ? tr("memory.owner_decision") : source.descriptor.kind)} · ${escape(Array.from(source.text).slice(0, 80).join(""))}</option>` : "").join("")}</select></label>
      <label>${tr("memory.cite_existing_memory")} <select name="dependencies"><option value="[]">${tr("memory.dont_cite")}</option>${state.items.map(item => item.state === "available" ? `<option value="${escape(JSON.stringify([{ claimId: item.claim.claimId, revision: item.claim.revision, generation: item.claim.generation }]))}">${escape(Array.from(item.claim.text).slice(0, 80).join(""))}</option>` : "").join("")}</select></label><button class="primary">${tr("memory.run_simulated_extraction")}</button></form>` : `<p>${tr("memory.enable_a_role_with_a")}</p>`}
      ${excluded.length ? `<p role="note">${tr("common.source_2")} ${excluded.length} ${tr("memory.sets_excluded_from_automatic_memory")} ${excluded.map(({ source }) => sourceLink(p.id, source.reference, `${tr("memory.excluded_sources")}`)).join(" ")}</p>` : ""}
      <nav class="pagination" aria-label="${tr("memory.source_pages")}">${cursor.sourceAfter ? `<a href="${escape(href({ sourceAfter: 0 }))}">${tr("memory.first_source_page")}</a>` : ""}${state.sourcesNextAfter !== null ? `<a href="${escape(href({ sourceAfter: state.sourcesNextAfter }))}">${tr("memory.next_source_page")}</a>` : ""}</nav></section>
    <section><h2>${tr("memory.extraction_results_and_gaps")}</h2>${state.extractions.map(e => `<article class="team-card" id="extraction-${e.id}"><p>${escape(e.state)} · ${escape(e.reason)} · fixture · ${escape(e.extractor)} · policy ${e.policy}</p><p>${tr("memory.queue")} ${escape(e.job.state)} · ${escape(e.job.reason)} · ${escape(e.job.nextAction)} · <a href="/projects/${p.id}/jobs/${e.jobId}">${tr("memory.review_and_stop_job")}</a></p><p>${e.claimIds.length} ${tr("memory.claims_rejected")} ${e.rejected} ${tr("memory.items")}</p><p>${tr("memory.configured_route")} ${escape(e.route.provider)} / ${escape(e.route.model)} ${tr("memory.live_access_not_verified")}</p><p>${sourceLink(p.id, e.source.reference, `${tr("common.source_2")} ${e.source.state}`)}</p></article>`).join("") || `<p>${tr("memory.no_extraction_requests_yet")}</p>`}
    <nav class="pagination" aria-label="${tr("memory.result_pages")}">${cursor.extractionAfter ? `<a href="${escape(href({ extractionAfter: 0 }))}">${tr("memory.first_results_page")}</a>` : ""}${state.extractionsNextAfter !== null ? `<a href="${escape(href({ extractionAfter: state.extractionsNextAfter }))}">${tr("memory.next_results_page")}</a>` : ""}</nav></section></div>`);
}

const scheduleKindLabels = (): Record<JobSchedule["kind"], string> => ({ reminder: tr("common.reminder"), summary: tr("schedules.scheduled_summary") });
const scheduleStateLabels = (): Record<JobSchedule["state"], string> => ({ active: tr("schedules.running"), paused: tr("schedules.paused"), revoked: tr("schedules.cancelled") });
function recurrenceLabel(schedule: JobSchedule): string {
  const rec = schedule.recurrence;
  if (rec.kind === "once") return `${tr("schedules.once")} ${new Date(rec.at).toISOString()}`;
  if (rec.kind === "interval") return rec.everyMs % 3600000 === 0 ? `${tr("schedules.every")} ${rec.everyMs / 3600000} ${tr("schedules.hours")}` : `${tr("schedules.every")} ${rec.everyMs / 60000} ${tr("schedules.minutes")}`;
  return `${tr("schedules.daily")} ${escape(rec.time)} (${escape(schedule.timezone)})`;
}
function wallClock(instant: number, timezone: string): string {
  try {
    return escape(new Intl.DateTimeFormat("th-TH", { timeZone: timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(instant)));
  } catch { return tr("schedules.invalid_time_zone"); }
}
function nextRunLine(schedule: JobSchedule): string {
  if (schedule.nextRun === null) return `<p>${tr("schedules.next_run")} ${escape(schedule.nextRunNote ? systemText(schedule.nextRunNote) : tr("schedules.not_scheduled"))}</p>`;
  return `<p>${tr("schedules.next_run")} ${time(schedule.nextRun)} ${tr("schedules.local_time")} ${wallClock(schedule.nextRun, schedule.timezone)}</p>${schedule.nextRunNote ? `<p>${escape(systemText(schedule.nextRunNote))}</p>` : ""}`;
}
function lastResultLine(projectId: string, schedule: JobSchedule): string {
  const last = schedule.lastResult;
  if (!last) return `<p>${tr("schedules.latest_result_no_completed_run")}</p>`;
  return `<p>${tr("schedules.latest_result")} ${time(last.completedAt)} · <a href="/projects/${projectId}/jobs/${last.jobId}">${tr("schedules.job_for_this_run")}</a> (${escape(last.state)} · ${escape(last.reason)})</p>
    ${last.deliveryIntentId ? `<p><a href="/projects/${projectId}/delivery">${tr("schedules.view_this_runs_delivery_requests")}</a></p>` : ""}
    ${last.outputSource ? `<p><a href="/projects/${projectId}/sources/${last.outputSource.sourceId}?revision=${last.outputSource.revision}&generation=${last.outputSource.generation}">${tr("schedules.open_saved_summary")}</a></p>` : ""}`;
}

/** Lists configured reminder/summary schedules with next run and last result, plus the owner create form. */
export function schedulesPage(state: ReturnType<Application["schedules"]>, workspace: Workspace, csrf: string, topics: Topic[], limits: JobLimits): string {
  const { project } = state, base = `/projects/${project.id}/schedules`;
  const card = (schedule: JobSchedule) => `<article class="team-card" id="schedule-${schedule.id}"><header><h3><a href="${base}/${schedule.id}">${escape(schedule.purpose)}</a></h3><span class="job-status" data-state="${schedule.state}">${scheduleStateLabels()[schedule.state]}</span></header>
    <p>${escape(scheduleKindLabels()[schedule.kind])} · ${recurrenceLabel(schedule)} ${tr("schedules.runs_remaining")} ${schedule.occurrencesRemaining}</p>
    ${nextRunLine(schedule)}${lastResultLine(project.id, schedule)}
    <p><small>contract ${escape(schedule.contract)} · revision ${schedule.revision}</small></p>
    ${schedule.state === "active" ? `<form method="post" action="${base}/${schedule.id}/pause">${hiddenCommand(csrf, schedule.revision)}<button>${tr("schedules.paused")}</button></form>` : ""}
    ${schedule.state === "paused" ? `<form method="post" action="${base}/${schedule.id}/resume">${hiddenCommand(csrf, schedule.revision)}<button class="primary">${tr("schedules.resume_without_backfilling_missed_runs")}</button></form>` : ""}
    ${schedule.state !== "revoked" ? `<form method="post" action="${base}/${schedule.id}/revoke">${hiddenCommand(csrf, schedule.revision)}<button class="danger">${tr("schedules.cancel_schedule")}</button></form>` : ""}
    ${schedule.state !== "revoked" ? `<details><summary>${tr("schedules.edit_new_revision_missed_runs")}</summary><form class="team-form" method="post" action="${base}/${schedule.id}/edit">${hiddenCommand(csrf, schedule.revision)}
      <label>${tr("schedules.purpose")}<input name="purpose" required maxlength="300" value="${escape(schedule.purpose)}"></label>
      <label>${tr("schedules.time_zone")}<input name="timezone" required maxlength="128" value="${escape(schedule.timezone)}"><small>${tr("schedules.iana_name_only_e_g")}</small></label>
      <label>${tr("schedules.recurrence_json")}<input name="recurrence" required value="${escape(JSON.stringify(schedule.recurrence))}"><small>{"kind":"daily","time":"08:00"} · {"kind":"interval","everyMs":3600000} · {"kind":"once","at":1735689600000}</small></label>
      <label>${tr("common.status")}<select name="enabled"><option value="true"${schedule.state === "active" ? " selected" : ""}>${tr("schedules.active")}</option><option value="false"${schedule.state !== "active" ? " selected" : ""}>${tr("schedules.paused")}</option></select></label>
      <label>${tr("schedules.summary_route_json_or_null")}<input name="route" required value="${escape(JSON.stringify(schedule.route))}"><small>${tr("schedules.reminders_use_null_summaries_need")} <code>{"provider":"grok","model":"...","authRoute":"..."}</code></small></label>
      <label>${tr("schedules.remaining_budget")}<input name="occurrenceBudget" required value="${schedule.occurrencesRemaining}"></label>
      <label>${tr("common.message")}<textarea name="text" required rows="3" maxlength="2048">${escape(schedule.payload.text)}</textarea></label>
      <input type="hidden" name="limits" value="${escape(JSON.stringify(schedule.limits))}"><button class="primary">${tr("schedules.save_new_revision")}</button></form></details>` : ""}</article>`;
  return shell(tr("schedules.project_schedules"), { project, workspace, csrf, section: "jobs" }, `<div class="content"><section class="hero"><p class="eyebrow">jobs.configured_schedules/v1</p><h2>${tr("schedules.scheduled_reminders_and_summaries_for")} ${escape(project.name)}</h2><p>${tr("schedules.missed_runs_are_coalesced_into")}</p></section>
    <details class="team-card" id="new-schedule"${state.items.length ? "" : " open"}><summary>${tr("schedules.new_schedule")}</summary><form class="team-form" method="post" action="${base}">${hiddenCommand(csrf, project.revision)}
      <label>${tr("common.topic")}<select name="topicId">${topics.map(topic => `<option value="${topic.id}">${escape(topic.title ?? tr("common.topic_unavailable"))}</option>`).join("")}</select></label>
      <label>${tr("common.type")}<select name="kind"><option value="reminder">${tr("common.reminder")}</option><option value="summary">${tr("schedules.scheduled_summary")}</option></select></label>
      <label>${tr("schedules.purpose")}<input name="purpose" required maxlength="300" placeholder="${tr("schedules.e_g_remind_me_to")}"></label>
      <label>${tr("schedules.time_zone")}<input name="timezone" required maxlength="128" value="Asia/Bangkok"><small>${tr("schedules.iana_name_only_device_time")}</small></label>
      <label>${tr("schedules.recurrence_json")}<input name="recurrence" required value="${escape(JSON.stringify({ kind: "daily", time: "08:00" }))}"><small>{"kind":"daily","time":"08:00"} · {"kind":"interval","everyMs":3600000} · {"kind":"once","at":1735689600000}</small></label>
      <label>${tr("common.status")}<select name="enabled"><option value="true">${tr("schedules.active")}</option><option value="false">${tr("schedules.paused")}</option></select></label>
      <label>${tr("schedules.summary_route_json_or_null")}<input name="route" required value="null"><small>${tr("schedules.reminders_use_null_summaries_need")} <code>{"provider":"grok","model":"...","authRoute":"..."}</code></small></label>
      <label>${tr("schedules.total_runs")}<input name="occurrenceBudget" required value="30"></label>
      <input type="hidden" name="misfire" value="coalesce"><input type="hidden" name="limits" value="${escape(JSON.stringify(limits))}">
      <label>${tr("common.message")}<textarea name="text" required rows="3" maxlength="2048" placeholder="${tr("schedules.reminder_text_or_a_note")}"></textarea></label>
      <button class="primary">${tr("schedules.create_schedule")}</button></form></details>
    <section aria-label="${tr("schedules.schedules")}">${state.items.length ? state.items.map(card).join("") : `<p class="empty-list">${tr("schedules.no_schedules_in_this_project")}</p>`}</section></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Shows one schedule, its recent occurrences and the fenced or committed job behind each. */
export function scheduleDetailPage(state: ReturnType<Application["schedule"]>, workspace: Workspace, csrf: string): string {
  const { project, schedule, occurrences } = state, base = `/projects/${project.id}/schedules`;
  const occurrence = (item: ScheduleOccurrence & { jobState: string }) => {
    const outcome = !item.outcome ? "" : (() => {
      const state = item.outcome.kind === "report" ? "succeeded" : item.outcome.kind === "no_update" ? "waiting" : "failed";
      // delivery.attention_levels/v1: a summary saved while the level was `needs-me` has no intent; say so.
      const key = item.outcome.kind === "report" ? item.deliveryIntentId ? "schedules.outcome_report" : "schedules.outcome_report_unnotified"
        : item.outcome.kind === "no_update" ? "schedules.outcome_no_update" : "schedules.outcome_failed";
      const reason = item.outcome.kind === "failed" ? ` ${tr("schedules.outcome_reason")} ${escape(item.outcome.reason ?? "")}` : "";
      return `<p><span class="job-status" data-state="${state}">${tr(key)}</span>${reason}</p>`;
    })();
    return `<article class="team-card"><p>${tr("schedules.run")} ${time(item.scheduledInstant)} · <a href="/projects/${project.id}/jobs/${item.jobId}">${tr("common.job_2")}</a> (${escape(item.jobState)}) · revision ${item.revision} · ${escape(item.resolution)}</p>
    ${outcome}
    ${item.missed ? `<p>${tr("schedules.coalesced_missed_runs")} ${item.missed.count} ${tr("common.times")} ${time(item.missed.from)}..${time(item.missed.to)} ${tr("schedules.into_one_run")}</p>` : ""}
    ${item.requestedWall ? `<p>${tr("schedules.requested_local_time")} ${escape(item.requestedWall)}</p>` : ""}</article>`;
  };
  return shell(schedule.purpose, { project, workspace, csrf, section: "jobs" }, `<div class="content"><section class="hero"><p class="eyebrow">${escape(scheduleKindLabels()[schedule.kind])} · ${escape(scheduleStateLabels()[schedule.state])}</p><h2>${escape(schedule.purpose)}</h2><p>${recurrenceLabel(schedule)} ${tr("schedules.runs_remaining")} ${schedule.occurrencesRemaining} · revision ${schedule.revision} · contract ${escape(schedule.contract)}</p></section>
    ${nextRunLine(schedule)}${lastResultLine(project.id, schedule)}
    <section aria-label="${tr("schedules.past_runs")}"><h2>${tr("schedules.past_runs")}</h2>${occurrences.length ? occurrences.map(occurrence).join("") : `<p class="empty-list">${tr("schedules.no_runs_due_yet")}</p>`}</section>
    <p><a href="${base}">${tr("schedules.back_to_all_schedules")}</a></p></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** ops.backup_manifest/v1: bounded inventory outside ordinary project data; never auto-activates workers. */
export function backupsPage(state: ReturnType<Application["backups"]>, workspace: Workspace, csrf: string, revision: number): string {
  const items = state.manifests.map(m => `<article class="team-card" id="backup-${m.id}"><header><h3><a href="/settings/backups/${m.id}">${escape(m.id)}</a></h3><span class="job-status" data-state="${m.state}">${escape(m.state)}</span></header>
    <p>schema ${m.appSchema} · app revision ${m.appRevision} · ${time(m.createdAt)} · ${m.content.projects} ${tr("backups.projects")} ${m.content.sources} ${tr("common.source")}</p>
    <p>native ${escape(m.native.state)}${m.native.reason ? ` · ${escape(m.native.reason)}` : ""} · lifecycle ${m.lifecycle.available ? `checkpoint ${escape(m.lifecycle.checkpoint ?? "")}` : escape(m.lifecycle.reason ?? "unavailable")}</p>
    <p><small>hash ${escape(m.content.hash.slice(0, 16))}… · ${m.content.bytes} bytes · contract ${escape(m.contract)}</small></p>
    ${m.state === "incomplete" ? `<p><small>${tr("backups.not_ready_to_restore_a")}</small></p>` : ""}</article>`).join("");
  return shell(tr("common.backup"), { workspace, csrf, section: "settings", settings: "backups" }, `<div class="content"><section class="hero"><p class="eyebrow">ops.backup_manifest/v1</p><h2>${tr("backups.verifiable_backups")}</h2><p>${tr("backups.a_consistent_snapshot_of_application")}</p></section>
    <form class="create-form" method="post" action="/backups">${hiddenCommand(csrf, revision)}<input type="hidden" name="note" value="manual backup"><button class="primary">${tr("backups.create_backup")}${icon("plus")}</button></form>
    <section aria-label="${tr("common.backup")}">${items || `<p class="empty-list">${tr("backups.no_backups_yet")}</p>`}</section></div>`);
}

/** One backup manifest: versions, hashes, completeness and retention without secret values. */
export function backupDetailPage(state: ReturnType<Application["backup"]>, workspace: Workspace, csrf: string): string {
  const m = state.manifest;
  return shell(`${tr("backups.backup")} ${m.id.slice(0, 8)}`, { workspace, csrf, section: "settings", settings: "backups" }, `<div class="content"><section class="hero"><p class="eyebrow">${escape(m.contract)} · ${escape(m.state)}</p><h2>${tr("common.backup")} ${escape(m.id)}</h2><p>${time(m.createdAt)} · schema ${m.appSchema} · app revision ${m.appRevision}</p></section>
    <article class="team-card"><h3>${tr("backups.completeness")}</h3><p>native ${escape(m.native.state)}${m.native.reason ? ` (${escape(m.native.reason)})` : ""} · lifecycle ${m.lifecycle.available ? tr("backups.ready") : escape(m.lifecycle.reason ?? tr("common.not_ready"))}</p>
    <p>projects ${m.content.projects} · sources ${m.content.sources} · ${m.content.bytes} bytes · hash ${escape(m.content.hash)}</p>
    <p>${tr("backups.max_retention")} ${m.retention.maxBackups} ${tr("backups.backups")} ${m.retention.maxBytes} bytes${m.retention.pruned.length ? ` ${tr("backups.pruned")} ${m.retention.pruned.length} ${tr("backups.backups_2")}` : ""}</p>
    ${m.reason ? `<p>${tr("common.reason")} ${escape(m.reason)}</p>` : ""}<p><small>artifact ${escape(m.artifact.path)} ${tr("backups.restore_only_through_ops02_quarantine")}</small></p></article>
    <p><a href="/settings/backups">${tr("backups.back_to_backups")}</a></p></div>`, { breadcrumb: { title: tr("common.backup"), href: "/settings/backups" } });
}

/** app.data_lifecycle/v1: bounded deletion previews and per-scope operations; never shows deleted payload. */
export function deletionsPage(state: { project: Project; operations: import("./memory/delete").DeletionOperation[] }, workspace: Workspace, csrf: string, sources: { reference: import("./sources").SourceReference; label: string }[]): string {
  const { project, operations } = state;
  const items = operations.map(op => `<article class="team-card" id="deletion-${op.id}"><header><h3><a href="/projects/${project.id}/memory/deletions/${op.id}">${escape(op.id)}</a></h3><span class="job-status" data-state="${op.state}">${escape(op.state)}</span></header>
    <p>scope ${escape(op.scope.source.sourceId)} r${op.scope.source.revision} g${op.scope.source.generation} · tombstones ${op.tombstones.length} · attempts ${op.attempts}/${op.maxAttempts} ${tr("deletions.native_sessions_deleted")} ${op.contexts.filter(c => c.state === "deleted").length}/${op.contexts.length}</p>
    <p>${tr("deletions.backups_still_holding_this_data")} ${op.backupsRetained.length ? escape(op.backupsRetained.join(", ")) : tr("common.none")} · ${escape(op.nextAction)}</p>
    ${op.reason ? `<p>${tr("common.reason")} ${escape(op.reason)}</p>` : ""}</article>`).join("");
  return shell(tr("deletions.delete_data"), { project, workspace, csrf, section: "settings", settings: "data" }, `<div class="content"><section class="hero"><p class="eyebrow">app.data_lifecycle/v1</p><h2>${tr("deletions.delete_source")} ${escape(project.name)}</h2><p>${tr("deletions.review_the_revision_bound_impact")}</p></section>
    <details class="team-card" open><summary>${tr("deletions.preview_source_impact")}</summary><form class="team-form" method="post" action="/projects/${project.id}/memory/deletions">${hiddenCommand(csrf, project.revision)}
      <input type="hidden" name="mode" value="preview"><label>${tr("common.source_2")}<select name="source">${sources.map(s => `<option value="${escape(JSON.stringify(s.reference))}">${escape(s.label)}</option>`).join("")}</select></label>
      <button class="primary">${tr("deletions.preview_impact")}</button></form></details>
    <section aria-label="${tr("deletions.deletions")}">${items || `<p class="empty-list">${tr("deletions.no_deletions_in_this_project")}</p>`}</section></div>`, { breadcrumb: { title: tr("settings.data"), href: "/settings/data" } });
}

/** One deletion preview or operation: complete collateral, named blockers, whole-session scope and per-scope state. */
export function deletionDetailPage(state: { project: Project; preview: import("./memory/delete").DeletionPreview | null; operation: import("./memory/delete").DeletionOperation | null }, workspace: Workspace, csrf: string): string {
  const { project, preview, operation } = state;
  const ref = (s: { sourceId: string; revision: number; generation: number }) => `${escape(s.sourceId)} r${s.revision} g${s.generation}`;
  const plus = (flag: boolean | undefined) => flag ? "+" : "";
  const blockers = preview?.blockers ?? [];
  const sessionRows = (preview?.affected.nativeSessions ?? []).map(session => `<li>${escape(session.id)} g${session.generation} · ${escape(session.appState)} · ${session.dispatched ? tr("deletions.session_already_has_data") : tr("deletions.not_started_yet")} ${tr("deletions.whole_session_deletion_only")}${session.collateral?.sources.length || session.collateral?.claims.length ? ` ${tr("deletions.also_deletes_sources")} ${session.collateral.sources.map(c => ref(c.source)).join(", ") || "-"} · claims ${session.collateral.claims.map(c => escape(c.claimId)).join(", ") || "-"}` : ""}</li>`).join("");
  const previewCard = preview ? `<article class="team-card"><h3>${tr("deletions.impact_of")} ${ref(preview.scope.source)}</h3>
    <p>${tr("deletions.expires")} ${time(preview.expiresAt)} · inventory ${escape((preview.inventoryDigest ?? "").slice(0, 12))} · claims ${preview.affected.claims.length}${plus(preview.truncated.claims)} · contexts ${preview.affected.contexts.length}${plus(preview.truncated.contexts)} ${tr("deletions.jobs_to_fence")} ${preview.affected.pendingJobs.length}${plus(preview.truncated.pendingJobs)}</p>
    <p>${tr("deletions.deleted_sources")} ${preview.affected.sources.map(s => `${ref(s.source)} (${s.relation === "scope" ? tr("common.source_2") : s.relation === "quoted_copy" ? tr("deletions.quoted_copy") : tr("deletions.derived_output")})`).join(" · ")}${plus(preview.truncated.sources)}</p>
    <p>${tr("label.native_sessions")} ${preview.affected.nativeSessions.length}${plus(preview.truncated.nativeSessions)} ${tr("deletions.backups_that_may_still_hold")} ${preview.affected.backups.length}${plus(preview.truncated.backups)} ${tr("deletions.local_exports_to_be_deleted")} ${preview.affected.exports.length}${plus(preview.truncated.exports)} ${tr("deletions.tasks_kept_unchanged")} ${preview.affected.obligations.length}${plus(preview.truncated.obligations)}</p>
    ${sessionRows ? `<ul aria-label="${tr("label.native_sessions")}">${sessionRows}</ul>` : ""}
    ${preview.wholeSession.required ? `<p>${tr("deletions.the_whole_session_must_be")}${escape((preview.wholeSession.reasons ?? [preview.wholeSession.reason ?? ""]).join(", "))}${tr("deletions.scope")} ${escape(preview.wholeSession.sessionScope.join(", "))} ${tr("deletions.confirm_the_whole_session_first")}</p>` : ""}
    ${blockers.length ? `<p class="error" role="alert">${tr("deletions.cannot_confirm")} ${escape(blockers.join(", "))} ${tr("deletions.review_the_data_and_request")}</p>` : ""}
    <p><small>${escape(systemText(preview.note))}</small></p>
    ${blockers.length ? "" : `<form class="team-form" method="post" action="/projects/${project.id}/memory/deletions">${hiddenCommand(csrf, project.revision)}
      <input type="hidden" name="mode" value="confirm"><input type="hidden" name="previewId" value="${preview.id}">
      <label><input type="checkbox" name="acknowledged" value="on"> ${tr("deletions.confirm_scope_does_not_cancel")}</label>
      ${preview.wholeSession.required ? `<label><input type="checkbox" name="acknowledgedWholeSession" value="on"> ${tr("deletions.confirm_whole_session_scope")}</label>` : ""}
      <button class="danger">${tr("deletions.confirm_deletion")}</button></form>`}</article>` : "";
  const contextRows = (operation?.contexts ?? []).map(context => `<li data-state="${escape(context.state)}">${escape(context.id)} g${context.generation} · ${escape(context.state)} · attempts ${context.attempts}${context.reason ? ` · ${escape(context.reason)}` : ""} · ${escape(context.nextAction)}</li>`).join("");
  const exportRows = (operation?.exports ?? []).map(entry => `<li data-state="${escape(entry.state)}">export ${escape(entry.id)} · ${escape(entry.state)} · attempts ${entry.attempts}${entry.reason ? ` · ${escape(entry.reason)}` : ""}</li>`).join("");
  const scopeRows = (operation?.scopes ?? []).map(scope => `<li data-state="${escape(scope.state)}">${escape(scope.scope)} · ${escape(scope.state)} · ${escape(scope.detail)}</li>`).join("");
  const operationCard = operation ? `<article class="team-card"><h3>${tr("deletions.deletions")} ${escape(operation.id)}</h3><p>${tr("common.status")} ${escape(operation.state)}${operation.state === "complete" ? tr("deletions.local_serving_and_managed_native") : ""} · attempts ${operation.attempts}/${operation.maxAttempts} · tombstones ${operation.tombstones.length}</p>
    <p>${escape(operation.nextAction)}${operation.reason ? ` · ${escape(operation.reason)}` : ""}</p>
    ${contextRows ? `<ul aria-label="${tr("label.native_session_scopes")}">${contextRows}</ul>` : `<p>${tr("deletions.no_native_sessions_to_delete")}</p>`}
    ${exportRows ? `<ul aria-label="${tr("label.local_export_artifacts")}">${exportRows}</ul>` : ""}
    ${scopeRows ? `<ul aria-label="${tr("label.local_scopes")}">${scopeRows}</ul>` : ""}
    <p>${tr("common.backups_still_holding_this_data")} ${operation.backupsRetained.length ? escape(operation.backupsRetained.join(", ")) : tr("common.none")}</p>
    <p>${tr("deletions.copies_not_deleted")} ${escape(operation.residuals.join(", "))}</p>
    ${operation.state === "pending" || operation.state === "blocked" ? `<form class="team-form" method="post" action="/projects/${project.id}/memory/deletions">${hiddenCommand(csrf, project.revision)}
      <input type="hidden" name="mode" value="retry"><input type="hidden" name="operationId" value="${operation.id}"><button>${tr("deletions.retry_native_session_cleanup")}</button></form>` : ""}</article>` : "";
  return shell(tr("deletions.deletion_result"), { project, workspace, csrf, section: "settings", settings: "data" }, `<div class="content">${previewCard}${operationCard || (!preview ? `<p class="empty-list">${tr("deletions.record_not_found")}</p>` : "")}
    <p><a href="/projects/${project.id}/memory/deletions">${tr("deletions.back_to_deletions")}</a></p></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** ops.project_export/v1: inspectable portable project data with lifecycle boundaries. */
export function exportsPage(state: { project: Project; manifests: import("./ops/export").ExportManifest[]; preview: import("./ops/export").ExportPreview }, workspace: Workspace, csrf: string): string {
  const { project, manifests, preview } = state;
  const items = manifests.map(m => `<article class="team-card" id="export-${m.id}"><header><h3><a href="/projects/${project.id}/exports/${m.id}">${escape(m.id)}</a></h3><span class="job-status" data-state="${m.state}">${escape(m.state)}</span></header>
    <p>${time(m.createdAt)} ${tr("exports.history")} ${m.scope.includeHistory ? tr("exports.includes_raw_messages") : tr("exports.metadata_only")} · claims ${m.counts.claims} ${tr("common.job")} ${m.counts.jobs} · exclusions ${m.exclusions.length}</p>
    <p><small>${m.artifact ? `hash ${escape(m.artifact.hash.slice(0, 16))}… · ${m.artifact.bytes} bytes` : `${tr("exports.failed")} ${escape(m.failure?.reason ?? "export_failed")} ${tr("exports.no_file")}`} · tombstones ${m.lifecycle.tombstonesApplied}</small></p></article>`).join("");
  return shell(tr("exports.export_data"), { project, workspace, csrf, section: "settings", settings: "data" }, `<div class="content"><section class="hero"><p class="eyebrow">ops.project_export/v1</p><h2>${tr("exports.export")} ${escape(project.name)}</h2><p>${tr("exports.a_re_verifiable_json_file")}</p></section>
    <details class="team-card" open><summary>${tr("exports.preview_before_export")}</summary><p>topics ${preview.counts.topics} · messages ${preview.counts.messages} · tasks ${preview.counts.tasks} · decisions ${preview.counts.decisions} · claims ${preview.counts.claims} · exclusions ${preview.manifest.exclusions.length} · missing ${preview.manifest.missingRefs.length}</p>
    <p><small>${escape(systemText(preview.manifest.lifecycle.note))}</small></p>
    <form class="team-form" method="post" action="/projects/${project.id}/exports">${hiddenCommand(csrf, project.revision)}
      <label><input type="checkbox" name="includeHistory" value="on"> ${tr("exports.include_raw_message_history_includes")}</label>
      <label>${tr("exports.note")}<input name="note" maxlength="500" value="manual export"></label>
      <button class="primary">${tr("exports.create_export")}</button></form></details>
    <section aria-label="${tr("exports.export_file")}">${items || `<p class="empty-list">${tr("exports.no_exports_yet")}</p>`}</section></div>`, { breadcrumb: { title: tr("settings.data"), href: "/settings/data" } });
}

/** One export manifest: versions, coverage, exclusions, residuals and artifact reference. */
export function exportDetailPage(state: { project: Project; manifest: import("./ops/export").ExportManifest }, workspace: Workspace, csrf: string): string {
  const { project, manifest: m } = state;
  return shell(`${tr("exports.export")} ${m.id.slice(0, 8)}`, { project, workspace, csrf, section: "settings", settings: "data" }, `<div class="content"><section class="hero"><p class="eyebrow">${escape(m.contract)} · ${escape(m.state)}</p><h2>${tr("exports.export_file")} ${escape(m.id)}</h2><p>${time(m.createdAt)} ${tr("exports.history_scope")} ${m.scope.includeHistory ? tr("exports.includes_raw_messages") : tr("exports.metadata_only")}</p></section>
    <article class="team-card"><h3>${tr("exports.scope_and_completeness")}</h3><p>topics ${m.counts.topics} · messages ${m.counts.messages} · tasks ${m.counts.tasks} · decisions ${m.counts.decisions} · claims ${m.counts.claims} · jobs ${m.counts.jobs} · deliveries ${m.counts.deliveries}</p>
    <p>exclusions ${m.exclusions.length} · missing ${m.missingRefs.length} ${tr("exports.pending_deletions")} ${m.pendingDeletions.length} · tombstones ${m.lifecycle.tombstonesApplied}</p>
    <p>${tr("common.backups_still_holding_this_data")} ${m.residuals.backups.length ? escape(m.residuals.backups.join(", ")) : tr("common.none")} ${tr("exports.external")} ${escape(m.residuals.external.join(", "))}</p>
    <p>${tr("exports.format")} ${m.formatVersion} · schema ${m.appSchema} ${tr("exports.not_a_restorable_backup_and")} ${m.disclosure.rawHistory === "included" ? tr("exports.included") : tr("exports.metadata_only")}</p>
    <p><small>${m.artifact ? `hash ${escape(m.artifact.hash)} · ${m.artifact.bytes} bytes · ${m.artifact.storage === "sqlite" ? `<a href="${escape(m.artifact.downloadPath)}" download>${tr("exports.download_json")}</a>` : `${tr("exports.legacy_format_file")} ${escape(m.artifact.path)} ${tr("exports.fsync_not_confirmed")}`}` : `${tr("exports.export_failed")} ${escape(m.failure?.reason ?? "export_failed")} ${tr("exports.stage")} ${escape(m.failure?.stage ?? "stage")}${tr("exports.no_file_was_published")}`}</small></p></article>
    <p><a href="/projects/${project.id}/exports">${tr("exports.back_to_exports")}</a></p></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

type UpgradeView = import("./ops/upgrade").UpgradeJournal & { actions: import("./ops/upgrade").UpgradeAction[] };

/**
 * ops.schema_migrations/v1: inspectable staged upgrades with recoverable prior
 * versions. The prepare form targets the one schema this build supports
 * (`status.target`), and is offered only when preflight can pass.
 */
export function upgradesPage(state: { journals: UpgradeView[]; status: import("./ops/upgrade").UpgradeStatus }, workspace: Workspace, csrf: string, revision: number): string {
  const s = state.status;
  const items = state.journals.map(j => `<article class="team-card" id="upgrade-${j.id}"><header><h3><a href="/settings/upgrades/${j.id}">${escape(j.id)}</a></h3><span class="job-status" data-state="${j.state}">${escape(j.state)}</span></header>
    <p>schema ${j.fromSchema} → ${j.targetSchema} ${tr("upgrades.restore_point")} ${j.snapshotBackupId ? escape(j.snapshotBackupId) : tr("common.none")} · ${escape(j.nextAction)}</p>
    ${j.reason ? `<p>${tr("common.reason")} ${escape(j.reason)}</p>` : ""}</article>`).join("");
  const engine = s.engine.compatible ? `${escape(s.engine.contract ?? "")} (${escape(s.engine.engine ?? "engine")}${tr("upgrades.supported")}`
    : `${tr("upgrades.not_ready")} ${escape(s.engine.reason ?? "engine_unavailable")}`;
  const form = s.active || s.fenced ? `<p>${tr("upgrades.an_upgrade_is_pending")} <a href="/settings/upgrades/${s.active ? s.active.id : ""}">${tr("common.continue")}</a></p>`
    : `<form class="create-form" method="post" action="/upgrades">${hiddenCommand(csrf, revision)}<input type="hidden" name="targetSchema" value="${s.target}"><input type="hidden" name="note" value="manual upgrade"><button class="primary">${tr("upgrades.prepare_upgrade_to_schema")} ${s.target}${icon("plus")}</button></form>`;
  return shell(tr("upgrades.upgrade"), { workspace, csrf, section: "settings", settings: "upgrades" }, `<div class="content"><section class="hero"><p class="eyebrow">ops.schema_migrations/v1</p><h2>${tr("upgrades.staged_upgrade")}</h2><p>${tr("upgrades.run_preflight_pause_new_work")}</p></section>
    <article class="team-card"><h3>${tr("common.status")}</h3><p>${tr("upgrades.current_schema")} ${s.currentSchema} ${tr("upgrades.supported_target")} ${s.target} ${tr("upgrades.minimum_source")} ${s.supported.minSource}) · ${escape(s.jitVersion)} · engine ${engine}${s.fenced ? tr("upgrades.new_work_paused_during_upgrade") : ""}</p></article>
    ${form}
    <section aria-label="${tr("upgrades.upgrade")}">${items || `<p class="empty-list">${tr("upgrades.no_upgrades_yet")}</p>`}</section></div>`);
}

const upgradeActionLabels = (): Record<import("./ops/upgrade").UpgradeAction, string> => ({
  migrate: tr("upgrades.migrate_to_staged_copy"), validate: tr("upgrades.validate_staged_copy"), activate: tr("common.activate_and_reconcile"), rollback: tr("upgrades.cancel_keep_live_data_unchanged"),
});

/** One upgrade journal: preflight, staged steps, validation report and the recovery choices valid for its phase. */
export function upgradeDetailPage(state: { journal: UpgradeView }, workspace: Workspace, csrf: string, revision: number): string {
  const j = state.journal;
  const checks = j.validation ? j.validation.checks.map(c => `<li>${escape(c.name)}: ${c.pass ? tr("common.passed") : tr("common.failed")} <small>${escape(c.detail)}</small></li>`).join("") : `<li>${tr("common.not_validated_yet")}</li>`;
  const action = (name: import("./ops/upgrade").UpgradeAction) => `<form class="team-form" method="post" action="/upgrades/${j.id}">${hiddenCommand(csrf, revision)}<input type="hidden" name="action" value="${name}"><button>${upgradeActionLabels()[name]}</button></form>`;
  const engine = j.preflight.engine;
  const restoreHint = (j.state === "complete" || j.state === "activated") && j.snapshotBackupId
    ? `<p>${tr("upgrades.roll_back_restore_backup")} ${escape(j.snapshotBackupId)} ${tr("common.passed")} <a href="/settings/restores">quarantine (OPS02)</a> ${tr("upgrades.with_the_latest_ledger")}</p>` : "";
  return shell(`${tr("upgrades.upgrade")} ${j.id.slice(0, 8)}`, { workspace, csrf, section: "settings", settings: "upgrades" }, `<div class="content"><section class="hero"><p class="eyebrow">${escape(j.contract)} · ${escape(j.state)}</p><h2>${tr("upgrades.schema_upgrade")} ${j.fromSchema} → ${j.targetSchema}</h2><p>${escape(j.nextAction)}${j.reason ? ` · ${escape(j.reason)}` : ""}</p></section>
    <article class="team-card"><h3>${tr("ops.preflight")}</h3><p>${escape(j.preflight.jitVersion)} · engine ${escape(engine.engine ?? tr("common.not_ready"))} · ${escape(engine.contract ?? tr("upgrades.no_contract"))} v${engine.formatVersion ?? "-"} · compatible ${j.preflight.compatible ? tr("upgrades.yes") : tr("upgrades.no")} · migrations ${escape(j.preflight.migrations.join(", ") || tr("common.none"))}</p>
    <h3>${tr("ops.steps")}</h3><ul>${j.steps.map(s => `<li>${escape(s.name)}: ${s.ok ? tr("common.passed") : tr("common.failed_2")} <small>${escape(s.detail)}</small></li>`).join("")}</ul>
    <h3>${tr("ops.validation")}</h3><ul>${checks}</ul>
    <p>${tr("upgrades.restore_point_2")} ${j.snapshotBackupId ? escape(j.snapshotBackupId) : tr("common.none")}${j.checkpoint ? ` · schema ${j.checkpoint.appSchema} · native refs ${j.checkpoint.nativeRefs}` : ""} · ledger ${j.ledger ? `tombstones ${j.ledger.deletions} · suppressions ${j.ledger.suppressions} · sources ${j.ledger.sources}` : tr("common.none")} · reconcile ${j.reconcile ? escape(j.reconcile.detail) : tr("upgrades.not_done_yet")}</p>
    ${restoreHint}
    <div>${j.actions.map(action).join(" ")}</div></article>
    <p><a href="/settings/upgrades">${tr("upgrades.back_to_upgrades")}</a></p></div>`, { breadcrumb: { title: tr("upgrades.upgrade"), href: "/settings/upgrades" } });
}

type RestoreView = import("./ops/restore").RestoreEvidence;
type LedgerView = { state: "trusted"; head: number; count: number; writtenAt: number; established: boolean }
  | { state: "untrusted"; reason: string; nextAction: string; head: number | null; count: number | null };

/** ops.quarantined_restore/v1: restore journals, installation ledger trust and the prepare form. */
export function restoresPage(state: { quarantines: RestoreView[]; ledger: LedgerView; backups: import("./ops/backup").BackupManifest[] }, workspace: Workspace, csrf: string, revision: number): string {
  const items = state.quarantines.map(q => `<article class="team-card" id="restore-${q.id}"><header><h3><a href="/settings/restores/${q.id}">${escape(q.id)}</a></h3><span class="job-status" data-state="${q.state}">${escape(q.state)}</span></header>
    <p>backup ${escape(q.backupId)} · schema ${q.compat.backupSchema} → ${q.stagedSchema ?? "?"} · ledger ${q.ledger ? `head ${q.ledger.head} (${q.ledger.deletions} tombstones, ${q.ledger.suppressions} suppressions)` : tr("restores.not_used_yet")} · ${escape(q.nextAction)}</p>
    ${q.reason ? `<p>${tr("common.reason")} ${escape(q.reason)}</p>` : ""}</article>`).join("");
  const options = state.backups.map(m => `<option value="${m.id}">${escape(m.id)} · schema ${m.appSchema} · ${escape(m.state)}</option>`).join("");
  const ledger = state.ledger.state === "trusted"
    ? `${tr("restores.installation_ledger_trusted_head")} ${state.ledger.head} · ${state.ledger.count} ${tr("common.items")}`
    : `${tr("restores.installation_ledger_untrusted")} ${escape(state.ledger.reason)} · ${escape(state.ledger.nextAction)}`;
  const active = state.quarantines.find(q => !["complete", "failed", "discarded"].includes(q.state));
  const form = active ? `<p>${tr("restores.a_restore_is_pending")} <a href="/settings/restores/${active.id}">${tr("common.continue")}</a></p>`
    : `<form class="team-form" method="post" action="/restores">${hiddenCommand(csrf, revision)}<label>${tr("common.backup")}<select name="backupId">${options}</select></label><input type="hidden" name="note" value="manual restore"><button class="primary">${tr("restores.prepare_quarantine")}</button></form>`;
  return shell(tr("restores.restore"), { workspace, csrf, section: "settings", settings: "restores" }, `<div class="content"><section class="hero"><p class="eyebrow">ops.quarantined_restore/v1</p><h2>${tr("restores.quarantined_restore")}</h2><p>${tr("restores.check_manifest_schema_and_engine")}</p></section>
    <article class="team-card"><h3>${tr("ops.ledger")}</h3><p>${ledger}</p></article>
    ${form}
    <section aria-label="quarantine">${items || `<p class="empty-list">${tr("restores.no_quarantine_yet")}</p>`}</section></div>`);
}

const restoreActionLabels = (): Record<import("./ops/restore").RestoreAction, string> => ({
  migrate: tr("restores.migrate_check_quarantine_schema"), apply_ledger: tr("restores.apply_the_installations_latest_ledger"), validate: tr("restores.validate_quarantine"),
  activate: tr("common.activate_and_reconcile"), discard: tr("restores.discard_quarantine_keep_live_data"),
});

/** One restore: compatibility, steps, validation checks, owner report and the actions valid for its phase. */
export function restoreDetailPage(state: { quarantine: RestoreView }, workspace: Workspace, csrf: string, revision: number): string {
  const q = state.quarantine, r = q.report;
  const checks = q.validation ? q.validation.checks.map(c => `<li>${escape(c.name)}: ${c.pass ? tr("common.passed") : tr("common.failed")} <small>${escape(c.detail)}</small></li>`).join("") : `<li>${tr("common.not_validated_yet")}</li>`;
  const action = (name: import("./ops/restore").RestoreAction) => `<form class="team-form" method="post" action="/restores/${q.id}">${hiddenCommand(csrf, revision)}<input type="hidden" name="action" value="${name}"><button>${restoreActionLabels()[name]}</button></form>`;
  const inv = r.invalidated;
  return shell(`${tr("restores.restore")} ${q.id.slice(0, 8)}`, { workspace, csrf, section: "settings", settings: "restores" }, `<div class="content"><section class="hero"><p class="eyebrow">${escape(q.contract)} · ${escape(q.state)}</p><h2>quarantine ${escape(q.id)}</h2><p>backup ${escape(q.backupId)} · ${escape(q.nextAction)}${q.reason ? ` · ${escape(q.reason)}` : ""}</p></section>
    <article class="team-card"><h3>${tr("ops.versions")}</h3><p>backup ${escape(r.versions.backupJit)} schema ${r.versions.backupSchema} → build ${escape(r.versions.currentJit)} schema ${r.versions.currentSchema} · quarantine ${r.versions.quarantineSchema ?? "?"} · native refs ${r.versions.engine.nativeRefs} · engine ${r.versions.engine.compatible ? tr("restores.supported") : `${tr("restores.not_supported")}${escape(r.versions.engine.reason ?? "")})`}</p>
    <h3>${tr("ops.steps")}</h3><ul>${q.steps.map(s => `<li>${escape(s.name)}: ${s.ok ? tr("common.passed") : tr("common.failed_2")} <small>${escape(s.detail)}</small></li>`).join("")}</ul>
    <h3>${tr("ops.validation")}</h3><ul>${checks}</ul>
    <h3>${tr("ops.ledger")}</h3><p>${r.ledger ? `installation lifecycle ledger head ${r.ledger.head} · tombstones ${r.ledger.deletions} · suppressions ${r.ledger.suppressions} · backup checkpoint ${escape(r.ledger.backup.checkpoint ?? tr("common.none"))}` : tr("restores.not_used_yet")}</p>
    <h3>${tr("restores.invalidated_data")}</h3><p>${inv ? `sources ${inv.sourcesPurged} ${tr("restores.claims_deleted")} ${inv.claimsPurged} ${tr("restores.claims_forgotten")} ${inv.claimsForgotten} · suppressions ${inv.suppressionsApplied} (+${inv.ledgerOnlySuppressions} ${tr("restores.enforced_by_ledger_contexts_retired")} ${inv.contextsRetired} ${tr("restores.already_deleted_in_live")} ${inv.contextsAlreadyDeleted} ${tr("restores.pending_deletion")} ${inv.contextsScheduledForDeletion} · jobs fence ${inv.jobsFenced} · attempts ${inv.attemptsFenced} ${tr("restores.notifications_paused")} ${inv.deliveriesHeld}` : tr("restores.ledger_not_applied_yet")}</p>
    <h3>${tr("restores.pending_suspended")}</h3><p>${tr("restores.jobs_awaiting_owner_resume")} ${r.pending.jobsAwaitingOwnerResume} ${tr("restores.notifications_with_unknown_status")} ${r.pending.unknownDeliveries} ${tr("restores.native_pending_deletion")} ${r.pending.nativeDeletesPending} ${tr("restores.live_data_after_the_backup")} ${r.discarded.liveOnlyProjects}, sources ${r.discarded.liveOnlySources}, contexts ${r.discarded.liveOnlyContexts}</p>
    <h3>${tr("restores.retention_limits")}</h3><ul>${r.retention.map(item => `<li>${escape(item)}</li>`).join("")}</ul>
    <h3>${tr("restores.activation_decision")}</h3><p>${r.activation.allowed ? tr("restores.ready_to_activate") : `${tr("restores.cannot_activate_yet")} ${escape(r.activation.blockers.join(", ") || q.nextAction)}`} · revision live ${r.generation.liveRevision ?? "?"} → ${r.generation.restoredRevision ?? "?"}${r.generation.sessionsRevoked ? tr("restores.previous_sessions_revoked") : ""}</p>
    <div>${q.actions.map(action).join(" ")}</div></article>
    <p><a href="/settings/restores">${tr("restores.back_to_restores")}</a></p></div>`, { breadcrumb: { title: tr("restores.restore"), href: "/settings/restores" } });
}

/** Owner settings home: persisted appearance and language (ui.preferences/v1) and the persona; the sub-navigation leads to every operation. */
export function settingsPage(preferences: { theme: ThemePreference; language: "auto" | Locale; revision: number }, workspace: Workspace, csrf: string, persona?: Persona, localApi?: LocalApiSettings, attention?: AttentionLevels): string {
  const choice = (name: string, value: string, label: string, current: string) =>
    `<label class="choice"><input type="radio" name="${name}" value="${value}"${value === current ? " checked" : ""}>${label}</label>`;
  // app.persona/v1: the only Web writer of the persona is this owner form (setup reuses the same command).
  const personaSection = persona ? `<section class="settings-section" id="persona" aria-labelledby="persona-title"><h2 id="persona-title">${tr("settings.persona")}</h2><p>${tr("settings.persona_note")}</p>
    <form class="team-form persona-form" method="post" action="/settings/persona">${hiddenCommand(csrf, persona.revision)}
      <label>${tr("settings.persona_address")}<input name="addressAs" maxlength="60" value="${escape(persona.addressAs)}" autocomplete="off"></label>
      <label>${tr("settings.persona_self")}<input name="selfReference" maxlength="30" value="${escape(persona.selfReference)}" autocomplete="off"></label>
      <fieldset class="choice-group"><legend>${tr("settings.persona_language")}</legend>${choice("language", "th", tr("settings.language_th"), persona.language)}${choice("language", "en", tr("settings.language_en"), persona.language)}</fieldset>
      <fieldset class="choice-group"><legend>${tr("settings.persona_particle")}</legend>${choice("particle", "khrap", tr("settings.persona_particle_khrap"), persona.particle)}${choice("particle", "kha", tr("settings.persona_particle_kha"), persona.particle)}${choice("particle", "none", tr("settings.persona_particle_none"), persona.particle)}</fieldset>
      <fieldset class="choice-group"><legend>${tr("settings.persona_personality")}</legend>${choice("personality", "calm", tr("settings.persona_calm"), persona.personality)}${choice("personality", "direct", tr("settings.persona_direct"), persona.personality)}${choice("personality", "friendly", tr("settings.persona_friendly"), persona.personality)}</fieldset>
      <label>${tr("settings.persona_about")}<textarea name="aboutMe" maxlength="600" rows="3">${escape(persona.aboutMe)}</textarea></label>
      <small>${tr("settings.persona_revision")} ${persona.revision}</small><button class="primary">${tr("settings.persona_save")}</button></form></section>` : "";
  return shell(tr("shell.settings"), { workspace, csrf, section: "settings", settings: "general" }, `<div class="content settings-content">${personaSection}
    <section class="settings-section" id="appearance" aria-labelledby="appearance-title"><h2 id="appearance-title">${tr("settings.appearance")}</h2><p>${tr("settings.appearance_note")}</p>
    <form method="post" action="/settings/preferences">${hiddenCommand(csrf, preferences.revision)}
      <fieldset class="choice-group"><legend>${tr("settings.theme")}</legend>${choice("theme", "system", tr("settings.theme_system"), preferences.theme)}${choice("theme", "dark", tr("settings.theme_dark"), preferences.theme)}${choice("theme", "light", tr("settings.theme_light"), preferences.theme)}</fieldset>
      <fieldset class="choice-group"><legend>${tr("settings.language")}</legend>${choice("language", "auto", tr("settings.language_auto"), preferences.language)}${choice("language", "th", tr("settings.language_th"), preferences.language)}${choice("language", "en", tr("settings.language_en"), preferences.language)}</fieldset>
      <button class="primary">${tr("settings.save")}</button></form></section>
${localApi ? `<section class="settings-section" id="local-api" aria-labelledby="local-api-title"><h2 id="local-api-title">${tr("settings.local_api")}</h2><p>${tr("settings.local_api_note")}</p><p>${tr("settings.local_api_files")}</p>
    <form class="team-form" method="post" action="/settings/local-api">${hiddenCommand(csrf, localApi.revision)}
      <label class="choice"><input type="checkbox" name="enabled"${localApi.enabled ? " checked" : ""}>${tr("settings.local_api_enabled")}</label>
      <small>${tr(localApi.enabled ? "settings.local_api_state_on" : "settings.local_api_state_off")} · ${tr("settings.local_api_revision")} ${localApi.revision}</small><button class="primary">${tr("settings.local_api_save")}</button></form></section>` : ""}
${attention ? `<section class="settings-section" id="attention" aria-labelledby="attention-title"><h2 id="attention-title">${tr("settings.attention")}</h2><p>${tr("settings.attention_note")}</p>
    ${(["telegram", "web"] as const).map(channel => `<form class="team-form" method="post" action="/settings/attention">${hiddenCommand(csrf, attention[channel].revision)}<input type="hidden" name="channel" value="${channel}">
      <fieldset class="choice-group"><legend>${tr(channel === "telegram" ? "settings.attention_channel_telegram" : "settings.attention_channel_web")}</legend>${choice("level", "all", tr("settings.attention_level_all"), attention[channel].level)}${choice("level", "needs-me", tr("settings.attention_level_needs_me"), attention[channel].level)}</fieldset>
      ${channel === "web" ? `<p>${tr("settings.attention_web_note")}</p>` : ""}<small>${tr("settings.attention_revision")} ${attention[channel].revision}</small><button class="primary">${tr("settings.attention_save")}</button></form>`).join("")}</section>` : ""}
        <section class="settings-section" aria-labelledby="about-title"><h2 id="about-title">${tr("settings.about")}</h2><p class="licenses">${tr("settings.fonts_note")}
      <a href="${assetUrl("OFL-Inter.txt")}">Inter</a> · <a href="${assetUrl("OFL-NotoSansThai.txt")}">Noto Sans Thai</a> · <a href="${assetUrl("OFL-JetBrainsMono.txt")}">JetBrains Mono</a></p></section></div>`);
}
