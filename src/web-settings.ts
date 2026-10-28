import type { MessageKey } from "./i18n";

/**
 * web.settings_ia/v1 — where owner pages live after S09-D05 (UX02).
 *
 * - Installation operations (team and models, Telegram, backups, upgrades, restores) live under `/settings/*`.
 *   Their earlier page URLs answer `GET` with a permanent redirect to the new place, so no bookmark or link dies.
 * - Commands keep their endpoints: forms on the new pages still post to `/team/*`, `/backups`, `/upgrades/*` and
 *   `/restores/*` with the same session, Origin, CSRF, revision and receipt rules. JSON API paths do not move.
 * - Project data operations (exports, deletions) and Telegram notifications stay at their project URLs and render
 *   inside the settings frame. Memory, tasks, jobs, PR reports and the team stay at their project URLs too; the
 *   topic right panel links to them.
 */
export type SettingsSectionId = "general" | "team" | "dispatch" | "access" | "connections" | "telegram" | "feed" | "backups" | "upgrades" | "restores" | "data";

/** Settings sections in display order. `href` is the canonical page; `label` is a dictionary key. */
export const settingsSections: readonly { readonly id: SettingsSectionId; readonly href: string; readonly label: MessageKey }[] = Object.freeze([
  { id: "general", href: "/settings", label: "settings.general" },
  { id: "team", href: "/settings/team", label: "common.team_and_models" },
  { id: "dispatch", href: "/settings/dispatch", label: "settings.dispatch" },
  { id: "access", href: "/settings/access", label: "settings.access" },
  { id: "connections", href: "/settings/connections", label: "settings.connections" },
  { id: "telegram", href: "/settings/telegram", label: "settings.telegram" },
  { id: "feed", href: "/settings/feed", label: "settings.feed" },
  { id: "backups", href: "/settings/backups", label: "settings.backups" },
  { id: "upgrades", href: "/settings/upgrades", label: "settings.upgrades" },
  { id: "restores", href: "/settings/restores", label: "settings.restores" },
  { id: "data", href: "/settings/data", label: "settings.data" },
] as const);

const uuid = "[a-f0-9-]{36}";
/** Installation pages that moved: the old page path (GET only) and its new settings path. */
const moved = new RegExp(`^/(team|backups(?:/${uuid})?|upgrades(?:/${uuid})?|restores(?:/${uuid})?)$`);
/** New settings page paths that render through the existing installation page handlers. */
const alias = new RegExp(`^/settings/(team|backups(?:/${uuid})?|upgrades(?:/${uuid})?|restores(?:/${uuid})?)$`);

/** New location of a moved page path, or null. The caller keeps the query string; the browser keeps the fragment. */
export function legacyRedirect(pathname: string): string | null {
  const match = moved.exec(pathname);
  return match ? `/settings/${match[1]}` : null;
}

/** The page handler path behind a new settings page path (`/settings/backups/x` → `/backups/x`), or null. */
export function settingsPageHandler(pathname: string): string | null {
  const match = alias.exec(pathname);
  return match ? `/${match[1]}` : null;
}

/** Topic right panel tabs (S09-D05) in display order; the first open tab is `defaultPanelTab`. */
export const panelTabs = Object.freeze(["memory", "tasks", "jobs", "pr", "team"] as const);
export type PanelTab = (typeof panelTabs)[number];
export const defaultPanelTab: PanelTab = "tasks";
export const panelTabLabels: Readonly<Record<PanelTab, MessageKey>> = Object.freeze({
  memory: "label.memory", tasks: "common.tasks", jobs: "common.project_jobs", pr: "panel.pr_reports", team: "panel.team",
});
/** Rows a panel tab shows before linking to its full page. */
export const panelRows = 5;

/** ⌘K bounds: the longest query in code points and the most rows of each kind one query may return. */
export const searchLimits = Object.freeze({ query: 100, projects: 6, topics: 8, commands: 8 });

/** Navigation commands the palette offers; each opens a page and never runs an owner command. */
export const paletteCommands: readonly { readonly id: string; readonly href: string; readonly label: MessageKey }[] = Object.freeze([
  { id: "new-chat", href: "/", label: "shell.new_chat" },
  { id: "new-project", href: "/#new-project", label: "common.new_project" },
  { id: "appearance", href: "/settings#appearance", label: "settings.appearance" },
  ...settingsSections.filter(section => section.id !== "general"),
  { id: "settings", href: "/settings", label: "shell.settings" },
]);

/**
 * Route inventory: every page URL that existed before UX02 and where it resolves now. `redirect` answers 308 to
 * `to`; `settings` and `panel` render at the same URL inside the settings frame or as a panel's full page;
 * `page` is unchanged. Tests walk this table, so a new or moved page must be added here.
 */
export const routeInventory: readonly { readonly from: string; readonly kind: "redirect" | "settings" | "panel" | "page"; readonly to?: string; readonly section?: SettingsSectionId | PanelTab }[] = Object.freeze([
  { from: "/", kind: "page" },
  { from: "/login", kind: "page" },
  { from: "/settings", kind: "settings", section: "general" },
  { from: "/settings/preferences", kind: "redirect", to: "/settings#appearance", section: "general" },
  { from: "/settings/persona", kind: "redirect", to: "/settings#persona", section: "general" },
  { from: "/team", kind: "redirect", to: "/settings/team", section: "team" },
  { from: "/backups", kind: "redirect", to: "/settings/backups", section: "backups" },
  { from: "/backups/:backup", kind: "redirect", to: "/settings/backups/:backup", section: "backups" },
  { from: "/upgrades", kind: "redirect", to: "/settings/upgrades", section: "upgrades" },
  { from: "/upgrades/:upgrade", kind: "redirect", to: "/settings/upgrades/:upgrade", section: "upgrades" },
  { from: "/restores", kind: "redirect", to: "/settings/restores", section: "restores" },
  { from: "/restores/:restore", kind: "redirect", to: "/settings/restores/:restore", section: "restores" },
  // app.schedule_feed/v1 (REL08): the calendar feed settings page; added after UX02.
  { from: "/settings/feed", kind: "settings", section: "feed" },
  // web.access_settings/v1 (EXE04): execution access levels, role limits and the kill switch.
  { from: "/settings/access", kind: "settings", section: "access" },
  // web.connections_settings/v1 (EXE11): owner credentials for approved effects and MCP servers.
  { from: "/settings/connections", kind: "settings", section: "connections" },
  { from: "/projects/:project/exports", kind: "settings", section: "data" },
  { from: "/projects/:project/exports/:export", kind: "settings", section: "data" },
  { from: "/projects/:project/memory/deletions", kind: "settings", section: "data" },
  { from: "/projects/:project/memory/deletions/:deletion", kind: "settings", section: "data" },
  { from: "/projects/:project/delivery", kind: "settings", section: "telegram" },
  { from: "/projects/:project/delivery/:intent", kind: "settings", section: "telegram" },
  { from: "/projects/:project", kind: "page" },
  { from: "/projects/:project/topics", kind: "page" },
  { from: "/projects/:project/topics/:topic", kind: "page" },
  { from: "/projects/:project/topics/:topic/decisions", kind: "page" },
  { from: "/projects/:project/sources/:source", kind: "page" },
  { from: "/projects/:project/memory", kind: "panel", section: "memory" },
  { from: "/projects/:project/memory/claims/:claim", kind: "panel", section: "memory" },
  { from: "/projects/:project/memory/contexts/:context", kind: "panel", section: "memory" },
  { from: "/projects/:project/tasks", kind: "panel", section: "tasks" },
  { from: "/projects/:project/tasks/:task", kind: "panel", section: "tasks" },
  { from: "/projects/:project/jobs", kind: "panel", section: "jobs" },
  { from: "/projects/:project/jobs/:job", kind: "panel", section: "jobs" },
  { from: "/projects/:project/schedules", kind: "panel", section: "jobs" },
  { from: "/projects/:project/schedules/:schedule", kind: "panel", section: "jobs" },
  { from: "/projects/:project/pr/reports", kind: "panel", section: "pr" },
  { from: "/projects/:project/pr/reports/:report", kind: "panel", section: "pr" },
  { from: "/projects/:project/pr/alert-policy", kind: "panel", section: "pr" },
  { from: "/projects/:project/team", kind: "panel", section: "team" },
  { from: "/projects/:project/team/previews/:preview", kind: "panel", section: "team" },
  { from: "/projects/:project/team/discussions/:discussion", kind: "panel", section: "team" },
]);
