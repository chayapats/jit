# UX03 installable app, mobile layout and accessibility contract, v1

Owner: Jit #98 (S09 UX03). Status: implemented on the issue branch. Spec: [S09](../specs/S09-main-bot-and-chat-first-ui.md) (S09-D13, S09-AC07, S09-AC08). Requirements: FR-24, FR-25, NFR-06, NFR-09, NFR-11. Decisions: [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md). Builds on [UX01](web-design-system-v1.md) (`web.static_assets/v1`, `ui.design_tokens/v1`, `ui.i18n_dictionary/v1`) and [UX02](web-settings-ia-v1.md) (`web.settings_ia/v1`).

`web.pwa/v1` lives in `src/web-pwa.ts` (service worker path, cache allowlist and version), `src/web-assets/sw.js` (the hand-written worker), `src/web-icons.ts` (install icons drawn from the logo), the asset table in `src/web-assets.ts`, the document head in `src/web-layout.ts` and the route in `src/web.ts`.

## Installable app

| Part | Contract |
| --- | --- |
| Manifest | `manifest.webmanifest`, an entry of the hashed asset table (`application/manifest+json`, immutable). `{ id: "/", name: "Jit", short_name: "Jit", start_url: "/", scope: "/", display: "standalone", background_color, theme_color }` with the dark `--bg`. It is language-neutral: the product name is the same in Thai and English, so it needs no dictionary entry. `start_url` opens the sign-in page or the home. |
| Icons | `icon-192.png` and `icon-512.png` (`purpose: any`, the favicon's rounded tile with transparent corners), `icon-maskable-512.png` (`purpose: maskable`, a full-bleed tile with the figure inside the central 80 % safe circle) and `apple-touch-icon.png` (180 px, full-bleed, for iOS). All four are drawn from `appIcon` in `src/web-logo.ts`, the same geometry `favicon.svg` uses, by a dependency-free rasterizer. The PNGs are generated once and shipped in `src/web-assets/icons/`; after a logo change run `bun src/web-icons.ts`. A test decodes the shipped files and compares them with a fresh drawing. |
| Head | Every page links the manifest and the touch icon and sets `theme-color` (one value for an explicit theme, a dark/light pair with `media` for `system`). The viewport is `width=device-width,initial-scale=1,viewport-fit=cover`; zoom is never disabled. |
| Registration | `app.js` registers `/sw.js` with `scope: "/"` and `updateViaCache: "none"`, only when `isSecureContext` (HTTPS, or `localhost`). Registration failure is ignored: every page and form works without the worker, as without any script. |

## Service worker

`GET /sw.js` is public (it lists only public asset paths), carries the ADR 0028 CSP, `nosniff` and `Cache-Control: no-store`, and has a fixed URL so the browser can find updates. The body is `src/web-assets/sw.js` with its one table line filled in at startup: `const table = { version, paths }`.

- **Allowlist.** `paths` is `offlineAssets`: the stylesheet, `app.js`, the three fonts, `favicon.svg` and the four PNG icons from the asset table. The manifest and the font licences stay on the network. Nothing else can enter the cache.
- **Install** precaches exactly `paths` into `jit-static-<version>`. **Activate** deletes every other cache of the origin and claims open pages.
- **Fetch** answers only a same-origin `GET` whose path is in `paths` and has no query: from the cache, or from the network when the entry is missing, keeping only a complete `200` same-origin answer. Every other request (pages, `/api/*`, the topic event stream, `/login`, `/logout`, `/setup`, `/sw.js`, the manifest, licences, old hashes, other origins, other methods) is not intercepted at all, so it gets the server's normal `no-store` answer.
- **Version.** `version` is the first 16 hex digits of the SHA-256 of the sorted allowlisted paths. Each path already carries the SHA-256 of its body, so any changed CSS, script, font or icon gives a new worker body, a new cache and the deletion of the old one.
- There is no background sync, push, periodic sync, IndexedDB or storage of its own. No owner, project or authenticated data is ever cached, so signing out has nothing to clear.

Offline behaviour follows: with no network the browser shows its own offline page, because pages are never cached. This is intended (ADR 0028).

## Mobile layout (360–430 px)

The shell from UX01 stays: below 680 px the sidebar is an off-canvas drawer (CSS `:target` without script), and the composer sits at the bottom of the main column. UX03 adds:

- **Safe areas.** With `viewport-fit=cover` the installed app draws under the status bar, notch and home indicator. The header, sidebar, main column, topic panel, composer, sign-in and setup pages each keep their own spacing or the device inset (`env(safe-area-inset-*)`), whichever is larger. These rules come last in the stylesheet so no breakpoint undoes them. On screens without insets nothing moves.
- **Setup steps.** Below 520 px the step names wrap between words and a long word widens its own column, so "Personality" or "นิสัยของจิต" are never cut off.
- No page has horizontal scroll at 360, 390, 430 or 1280 px. Code blocks and the section pill strips scroll inside their own box, by design.

## Accessibility

Every main page, every setup step, sign-in and error pages pass these deterministic checks of the served HTML (`tests/fixtures/a11y.ts`), in Thai and English and in dark and light: matching `lang`, a title, zoom allowed, one `main` reached first by the skip link, one `h1`, unique ids, `for`/`aria-*` references that resolve, names for every link, button, summary and form control, decorative or labelled SVG, no positive `tabindex`, no focusable `aria-hidden` content, no nested interactive content, list structure, fieldset legends, and names for every dialog and for each `nav`/`aside` landmark (unique per kind). Colour contrast is covered by the `ui.design_tokens/v1` tests.

Keyboard and motion: `:focus-visible` shows a 2 px `--fg` outline on every control; the three controls that drop their own outline (the composer textarea, the create-form input and the ⌘K input) show focus on their container instead. One `prefers-reduced-motion: reduce` rule ends every animation and transition, including the breathing dot and the ตั้งจิต ceremony, and `app.js` skips the ceremony delay under the same query. The closed drawer is `visibility: hidden`, so it is out of the tab order.

UX03 named the three memory pagination landmarks (`memory.memory_pages`, `memory.source_pages`, `memory.result_pages`); they were the only unnamed landmarks.

## Evidence

`tests/web-ux03.test.ts`:

- the manifest, the head tags on every page and the icons (decoded and compared with a fresh drawing, maskable figure inside the safe circle);
- the worker route (public, `no-store`, CSP) and its allowlist;
- the worker run against fake `caches`/`fetch` that call the real web handler: after install, browsing every main page and every URL it references, and requests for pages, API, the event stream, auth pages, the manifest, licences, queries, old hashes, other origins and other methods, the cache holds exactly the allowlist and nothing else was answered;
- cache hit and miss handling;
- a new version deleting every older cache on activation;
- responsive snapshots at 360/390/430/1280 px (`tests/__snapshots__/web-ux03.test.ts.snap`): the stylesheet's media queries evaluated per width, with drawer, composer and safe-area invariants and no fixed width or grid track wider than the viewport;
- the accessibility checks above, a self-test that the checker rejects each problem it looks for, and the focus and reduced-motion rules.

Opt-in owner evidence, not a release gate: installing on a real phone over the VPN and measuring asset bytes and latency on the Pi. See [the runbook](../runbooks/pwa-mobile-evidence.md).
