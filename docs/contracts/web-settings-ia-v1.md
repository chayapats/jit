# UX02 settings, topic panel and ⌘K contract, v1

Owner: Jit #97 (S09 UX02). Status: implemented on the issue branch. Spec: [S09](../specs/S09-main-bot-and-chat-first-ui.md) (S09-D01, D05, D12, S09-AC07). Requirements: FR-10, FR-18, FR-24, FR-25, NFR-07, NFR-11. Decisions: [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md). Builds on [UX01](web-design-system-v1.md) (`ui.design_tokens/v1`, `ui.i18n_dictionary/v1`, `web.static_assets/v1`).

`web.settings_ia/v1` lives in `src/web-settings.ts` (sections, moved routes, panel tabs, search bounds and the route inventory), `src/web-navigation.ts` (search, panel and new settings pages), the shell in `src/web-layout.ts` and routing in `src/web.ts`.

## Settings

| Section | Page | What it holds |
| --- | --- | --- |
| General | `/settings` | Appearance and language (`ui.preferences/v1`, unchanged) and font licences |
| Team and models | `/settings/team` | Installation roles, default route and role routes |
| Telegram | `/settings/telegram` | Binding and inbox status (read only), each project's notification requests |
| Backups | `/settings/backups`, `/settings/backups/:id` | `ops.backup_manifest/v1` inventory and detail |
| Upgrades | `/settings/upgrades`, `/settings/upgrades/:id` | `ops.schema_migrations/v1` journals |
| Restores | `/settings/restores`, `/settings/restores/:id` | `ops.quarantined_restore/v1` console |
| Project data | `/settings/data` | Each project's export and deletion pages |

Every settings page shows the settings sub-navigation. Persona and dispatch allowance join this list in their own tickets.

- **Moved pages.** `GET /team`, `/backups[/:id]`, `/upgrades[/:id]` and `/restores[/:id]` answer `308` to the same path under `/settings`, keeping the query string. The redirect is static and runs before sign-in, so it reveals nothing.
- **Commands do not move.** Forms on the new pages still post to `/team/roles`, `/team/routes`, `/backups`, `/upgrades[/:id]` and `/restores[/:id]`, with the same session, `Origin`, CSRF, `requestId`, revision and receipt rules. Only the no-script `303` after a post now points at the settings page. `POST` to a `/settings/...` page path is `404`, so there is no second command endpoint. The restore gate now sends ordinary pages to `/settings/restores`.
- **JSON API paths do not move** (`/api/team`, `/api/backups`, `/api/upgrades`, `/api/restores`, …).
- **Project pages stay.** Exports and deletions (`/projects/:id/exports…`, `/projects/:id/memory/deletions…`) and notifications (`/projects/:id/delivery…`) keep their URLs and render inside the settings frame, under Project data and Telegram respectively.
- **Telegram status** comes from `Application.telegramStatus(actor)`. It is the same projection the Telegram channel uses (`readTelegramStatus`): binding state, credential presence, gap state, inbox counts and the next action. Binding and revocation stay outside the Web UI.

`routeInventory` lists every page URL that existed before UX02 with its kind: `redirect` (to a settings page), `settings` (renders in the settings frame), `panel` (a full page the topic panel links to) or `page` (unchanged). `tests/web-ux02.test.ts` walks the table. A new or moved page must be added there.

## Topic right panel

- The topic page has a header toggle, `<a class="panel-toggle" href="<topic>/panel" aria-controls="topic-panel" aria-expanded="false">`, and an empty `<aside id="topic-panel" hidden>` after the main pane. The panel is closed by default, and the topic page reads no panel data.
- `GET /projects/:project/topics/:topic/panel?tab=memory|tasks|jobs|pr|team` (default `tasks`) is the panel as its own page. It works without script. It reads only the selected tab and shows at most `panelRows` (5) rows, with a link to the full project page. The tabs read as follows:
  - Tasks: `Application.topicTasks` reads this topic's open tasks directly, newest first, with the task list's current-evidence projection. They are grouped as "waiting on you" (proposals and close reviews) and accepted.
  - Jobs: `Application.recentJobs` lists jobs waiting for an owner resume first, then the newest.
  - Memory, PR reports and team use the existing read models.
  - The topic itself is resolved with `Application.topic`, which reads no messages. An unknown or repeated `tab` is `400 invalid_panel_tab`. A topic outside the project is `404`. There is no API variant.
- Panel markup: `.panel-body` contains the heading `#topic-panel-title` (`tabindex="-1"`), a close link back to the topic, a tab list of plain links (`data-panel-tab`, `aria-current` on the open tab) and the content.
- With script, the toggle fetches the panel page with the session's own credentials (`GET`, `credentials: "same-origin"`) and moves its `.panel-body` into the aside. Focus goes to the heading. A tab link loads that tab in place and keeps focus on it. Escape, the close link or the toggle closes the panel and returns focus to the toggle. If the fetch fails, the browser opens the panel page itself, which is the no-script path.
- Project pages outside a topic (project, memory, tasks, jobs, PR reports, team, schedules) show the same five destinations as a project tools strip. The sidebar no longer nests those tools.

## ⌘K search

- `GET /search?q=` is a page with a GET form and server-rendered results. `GET /api/search?q=` returns `{ query, items: [{ kind: "project" | "topic" | "command", label, detail, href }], more }`.
- `Application.search(actor, query, searchLimits)` runs one bounded, read-only query. The query is at most 100 code points with no control characters, and a repeated `q` is `400 invalid_query`. It matches project names and current topic titles (substring, case-insensitive for ASCII), newest first, with at most 6 projects and 8 topics. `more` is set when more matched. An empty query reads no project data. Message bodies, sources and memory are never searched. Topic candidates go through the normal topic read, so an unavailable title is never returned. The read needs the owner session and respects the restore gate. It writes no audit row or receipt.
- Navigation commands (`paletteCommands`: new chat, new project, appearance, each settings section) match the query against both their Thai and English labels and are returned in the page language, at most 8. They only open pages.
- The shell renders a closed `<dialog id="palette">` on every signed-in page. Its labels and its empty, loading, error and "more" texts come from the dictionary as attributes. The sidebar's search link (`aria-keyshortcuts="Meta+K Control+K"`) opens `/search` without script.
- With script, ⌘K or Ctrl+K (or the search link) opens the dialog with focus on the query field (`role="combobox"`, `aria-controls="palette-results"`). Every pause in typing (120 ms) makes one `/api/search` request, and a newer query aborts the older one. Rows are built with `textContent` only, and any `href` that is not a same-origin absolute path (`//x`, `/\x`, a scheme) is dropped. ↑ and ↓ move `aria-activedescendant` and wrap. Typing clears the active row until the new results arrive. Enter opens the active row; with no active row, Enter submits the form to `/search`. The shortcut matches `event.code === "KeyK"`, so it works on the physical K key under the Thai layout. Escape or a backdrop click closes the dialog and returns focus to where it was. Nothing is preloaded or stored.

## Sidebar badges

`Application.attention(actor, projectIds)` returns `{ proposals, reviews, resumes }` per project, for at most 50 ids. It counts task proposals awaiting accept or dismiss and jobs waiting for an owner resume. It also counts obligations ready for close review, using the same current-evidence projection as the task list (at most 500 open obligations are projected). The sidebar asks for the projects it can show, plus the selected project. A project with waiting items gets `<span class="nav-badge">` with visible words and a number ("รอคุณ 2" / "Waiting 2"), a `title` breakdown and a screen-reader sentence. Colour alone never carries the state.

## Script reads

UX01's `app.js` sent no requests. UX02 adds exactly two same-origin `GET`s, both of which also work as ordinary pages: the topic panel page and `/api/search`. The script still never posts, never uses `innerHTML`, storage or cookies, and inserts owner text only as text. `tests/web-ui.test.ts` checks this in the asset.

## Evidence

`tests/web-ux02.test.ts` covers the following:

- the route inventory, with every old URL redirecting or rendering, query strings kept, redirects before sign-in, the API unmoved and no `POST` on settings page paths;
- forms on settings pages posting to the original endpoints with the same `role.save` receipt and stale-revision refusal, the settings sub-navigation in Thai and English, and the Telegram status page being read only;
- the panel being closed and empty on the topic page, the server focus order, each tab rendering, tab validation, project scope, no API variant, sign-in, and no state change;
- search bounds (limits, `more`, 100 code points, control characters, repeated `q`), name and title scope only (no message text), escaping, both-language command matching, and authorization;
- palette markup (a closed dialog, dictionary labels, the query field first in focus order);
- badges with words and numbers in Thai and English, only on projects with waiting items, and bounded `attention` validation;
- `app.js` contracts for the panel (open, focus in, tabs in place, Escape and focus return, reuse, fallback to the page) and the palette (shortcut, focus, arrows with wrap, Enter, Escape and focus return, unsafe `href`s dropped, text-only rows, empty and error states).

`tests/web-ui.test.ts` renders the new pages (settings sections, search, every panel tab) in Thai and English, dark and light. The existing ops and team suites use the new settings paths.
