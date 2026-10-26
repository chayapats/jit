# UX01 design system and shell contracts, v1

Owner: Jit #91 (S09 UX01). Status: implemented on the issue branch. Spec: [S09](../specs/S09-main-bot-and-chat-first-ui.md) (S09-D01, D05, D06, D10–D12, S09-AC07). Decisions: [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md), with [ADR 0007](../adr/0007-first-web-slice.md) for the parts it keeps. Visual values: [design/README.md](../design/README.md).

| Contract | Public entry and behavior |
| --- | --- |
| `ui.design_tokens/v1` | `src/web-design.ts`: `colorTokens.dark` and `colorTokens.light` have the same twelve colour tokens (`bg`, `surface-1..3`, `line`, `fg`, `fg-2`, `fg-3`, `on-fg`, `ok`, `warn`, `danger`). `scaleTokens` holds the font stacks, type scale, radii, motion durations and chat width. `contrastPairs` lists the text/background pairs that must reach WCAG AA (4.5:1) in both themes, and `contrastRatio` computes WCAG 2.x contrast. The stylesheet is generated from these values. Dark is the default. Light applies under `prefers-color-scheme: light` unless the owner chose dark, or whenever the owner chose light (`<html data-theme>`). There is no accent colour: only `ok`/`warn`/`danger` carry hue, and status always has text. |
| `ui.i18n_dictionary/v1` | `src/i18n`: `th` (default) defines the key set and `en` must define every key (enforced by the type checker and by `tests/web-ui.test.ts`). Values are trusted plain text without `< > & " '` or backticks. `tr(key)` reads the active language, `trMaybe(key)` returns null for unknown dynamic keys such as error codes, `withLocale(locale, render)` scopes a synchronous render, and `negotiateLocale(Accept-Language)` picks `th` or `en` (Thai fallback). `systemText(value)` translates a fixed Thai note returned by a domain read model only when it exactly matches a `system.*` entry; other text, including owner and model content, is returned unchanged. Error pages are keyed `error.<code>`. |
| `web.static_assets/v1` | `src/web-assets.ts`: a fixed table built at startup from `src/web-assets/` (stylesheet, `app.js`, three variable WOFF2 fonts, the favicon, three OFL licence texts). Each asset is served at `/assets/<name>.<sha256[0..16]>.<ext>` with `Cache-Control: public, max-age=31536000, immutable`, `nosniff` and the ADR 0028 CSP. Any other `/assets/` path is 404. Assets are public, contain no owner or project data and reference no remote origin. The stylesheet embeds the hashed font URLs. |
| `ui.preferences/v1` | `src/preferences.ts`, schema 24 `owner_preferences` (one row). `Application.preferences(actor)` returns `{ theme: "system" \| "dark" \| "light", language: "auto" \| "th" \| "en", revision, updatedAt }`, with defaults `system`/`auto`/`0`/`null`. `Application.execute(actor, { kind: "ui.preferences.set", requestId, projectId: null, expectedRevision, payload: { theme, language } })` returns `{ preferences }`. It is revisioned (`stale_revision`), idempotent by request id (`request_id_conflict` on a different payload), validated (`invalid_preferences`), audited and refused during upgrade or restore fences. HTTP: `GET /settings`, `POST /settings/preferences` (form → 303 `/settings#appearance`), `GET`/`POST /api/settings/preferences` (JSON). These use the same session, `Origin` and CSRF checks as every other command. |

## Rendering

Every HTML response is rendered by `renderWith({ locale, theme }, page)`. Before sign-in, or when preferences cannot be read, `Accept-Language` chooses the language and the theme is `system`. After sign-in, saved preferences apply, and `language: "auto"` still follows `Accept-Language`. HTML responses carry `Content-Language` and `Vary: Accept-Language, Cookie`.

The signed-in shell is the same on every page:

- a sidebar with the lockup, a "new chat" entry (home, until BOT01 adds the chat home), projects with the selected project's tools (memory, tasks, jobs, notifications, team) and topics nested under it, and Settings plus sign-out at the bottom;
- a main pane with a header and a scroll region. A composer appears where the page has one.

Below 680 px the sidebar becomes a drawer. The menu link targets `#sidebar` and CSS `:target` opens it, so it works without script. The script adds Escape, focus return and no history entry. Later S09 tickets fill the main pane (chat home, right panel, ⌘K) without changing this frame.

## Scripts

`app.js` is one hand-written ES module loaded with `<script type="module" src>` from the asset table. Pages contain no inline scripts, inline handlers or `javascript:` URLs, and the CSP forbids them. The script only enhances: the drawer, ⌘/Ctrl+Enter submitting the composer through its own form post, and textarea growth where `field-sizing` is unsupported. It sends no requests and stores nothing. Script-initiated mutations added by later tickets must use the existing session cookie, exact `Origin`, `X-CSRF-Token` and idempotent `requestId`, as the JSON API already requires.

## Evidence

`tests/web-ui.test.ts` covers the following:

- dictionary completeness and plain-text values;
- `Accept-Language` negotiation;
- AA contrast and monochrome tokens;
- hashed, immutable, self-hosted assets with licences, and 404 for unknown paths;
- the exact CSP on pages, API, assets and errors;
- 21 existing routes rendered in Thai and English, dark and light, with no raw keys, no inline script, escaped hostile content and no untranslated Thai on English pages;
- browser-default versus saved preferences;
- the preferences command (revision, replay, validation, auth, CSRF, Origin);
- a full no-script form-post flow (sign in, create a project, create a topic, send a message, propose a task, save preferences, stale replay, forged posts, sign out);
- status text and the drawer markup;
- the logo SVG.

Existing suites keep passing with Thai as the default language.
