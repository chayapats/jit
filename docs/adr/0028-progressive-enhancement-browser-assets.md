---
status: accepted
scope: S09 Web engineering choices; amends ADR 0007
---

# Progressive-enhancement browser scripts, local fonts and a static-only PWA

S09 (S09-D01, D05, D06, D11, D13) needs streaming replies, a growing composer, keyboard shortcuts, a collapsible sidebar, theme switching and an installable app. ADR 0007 excluded all browser JavaScript. This ADR replaces that one clause. The rest of ADR 0007 still applies: Bun HTTP, escaped server-rendered HTML, forms that post to the `Application` command boundary, and no outbound telemetry.

## Selected implementation

- Every page is still complete server-rendered HTML. Every command works by plain form post and redirect. Scripts add behavior only. A test suite renders and submits each flow with no script.
- Scripts are hand-written ES modules served by Jit from a fixed, content-hashed asset table. There is no framework, bundler, npm runtime dependency or remote origin. CSP becomes `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`. No inline scripts or `eval`.
- Script-initiated mutations use the same session, Origin and CSRF checks as forms, and carry the same idempotent request IDs.
- Live progress uses one authenticated Server-Sent Events stream per open topic. S12-D02 / STR01 #174 replaces persisted provisional progress with a bounded attempt-scoped memory mailbox ([web.reply_stream/v2](../contracts/web-reply-stream-v2.md)); committed outcomes still replay from the existing durable cursor. Reconnect never starts work. When the stream is unavailable, the page falls back to the normal refresh.
- Inter, Noto Sans Thai and JetBrains Mono are vendored as variable WOFF2 files under their OFL licenses and served from `self`. The logo is inline SVG.
- The PWA manifest and service worker cache only the versioned static asset table: CSS, scripts, fonts and icons. They never cache HTML, API, SSE or authenticated responses, and they never use background sync. A new asset version deletes old caches.
- Theme and language preferences are owner configuration. Before login, `prefers-color-scheme` and `Accept-Language` decide.

## Alternatives and consequences

Keeping no-JS would make streaming and the Grok-like composer impossible. A SPA framework would add a build pipeline and a separate API surface, and would weaken the tested form/CSRF boundary. Each script feature therefore needs both a no-script test and a script contract test. Asset and font bytes count toward the Pi resource profile (NFR-06).
